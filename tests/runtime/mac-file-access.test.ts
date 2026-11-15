import { type dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import { constants } from "node:os";

import { createMacFileAccess } from "../../src/runtime/mac-file-access.ts";

function fakeLibrary(symbols: {
  __error: () => number | null;
  acl_free: (acl: number) => number;
  acl_get_link_np: (filePath: Buffer, type: number) => number | null;
  statfs: (filePath: Buffer, buffer: Uint8Array) => number;
}): typeof dlopen {
  return (() => ({ symbols })) as unknown as typeof dlopen;
}

test("returns conservative results without Darwin file-access symbols", () => {
  let loads = 0;
  const load: typeof dlopen = (library) => {
    loads++;
    expect(library).toBe("/usr/lib/libSystem.B.dylib");
    throw new Error("Darwin library unavailable");
  };
  const linux = createMacFileAccess("linux", load);
  expect(linux.macPathHasNoAcl("/fixture")).toBe(false);
  expect(linux.macVolumeEnforcesOwnership("/fixture")).toBe(false);
  expect(loads).toBe(0);

  const darwin = createMacFileAccess("darwin", load);
  expect(darwin.macPathHasNoAcl("/fixture")).toBe(false);
  expect(darwin.macVolumeEnforcesOwnership("/fixture")).toBe(false);
  expect(loads).toBe(1);
});

test("frees an ACL and accepts only ENOENT as an absent ACL", () => {
  const errno = new Int32Array(1);
  let hasErrno = true;
  let acl: number | null = 1;
  const freed: number[] = [];
  const access = createMacFileAccess(
    "darwin",
    fakeLibrary({
      __error: () => (hasErrno ? ptr(errno) : null),
      acl_free: (handle) => {
        freed.push(handle);
        return 0;
      },
      acl_get_link_np: (filePath, type) => {
        expect(filePath).toEqual(Buffer.from("/fixture\0"));
        expect(type).toBe(0x100);
        return acl;
      },
      statfs: () => -1,
    }),
  );

  expect(access.macPathHasNoAcl("/fixture")).toBe(false);
  expect(freed).toEqual([1]);

  acl = null;
  errno[0] = constants.errno.ENOENT;
  expect(access.macPathHasNoAcl("/fixture")).toBe(true);

  errno[0] = constants.errno.EACCES;
  expect(access.macPathHasNoAcl("/fixture")).toBe(false);

  hasErrno = false;
  expect(access.macPathHasNoAcl("/fixture")).toBe(false);
  expect(freed).toEqual([1]);
});

test("honors Darwin statfs ownership flags and rejects a failed lookup", () => {
  let flags = 0x00200000;
  let status = 0;
  const access = createMacFileAccess(
    "darwin",
    fakeLibrary({
      __error: () => null,
      acl_free: () => 0,
      acl_get_link_np: () => null,
      statfs: (filePath, buffer) => {
        expect(filePath).toEqual(Buffer.from("/fixture\0"));
        if (status === 0) {
          new DataView(buffer.buffer).setUint32(64, flags, true);
        }
        return status;
      },
    }),
  );

  expect(access.macVolumeEnforcesOwnership("/fixture")).toBe(false);

  flags = 1;
  expect(access.macVolumeEnforcesOwnership("/fixture")).toBe(true);

  status = -1;
  expect(access.macVolumeEnforcesOwnership("/fixture")).toBe(false);
});
