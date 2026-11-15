import { type dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import { constants } from "node:os";

import { createLinuxDefaultAclCheck } from "../../src/runtime/linux-file-access";

test("uses the native ACL check lazily and fails closed if its symbols are unavailable", () => {
  const attempts: unknown[] = [];
  const load: typeof dlopen = (library) => {
    attempts.push(library);
    throw new Error("Native library unavailable");
  };
  expect(createLinuxDefaultAclCheck("darwin", "arm64", load)("/fixture")).toBe(
    false,
  );
  const lookup = createLinuxDefaultAclCheck("linux", "arm64", load);
  expect(attempts).toEqual([]);
  expect(lookup("/fixture")).toBe(false);
  expect(lookup("/fixture")).toBe(false);
  expect(attempts).toEqual(["libc.so.6", "libc.musl-aarch64.so.1"]);
});

test("accepts only absent or unsupported Linux default ACLs", () => {
  const errno = new Int32Array(1);
  let hasErrno = false;
  let status = 4;
  const symbols = {
    __errno_location: () => (hasErrno ? ptr(errno) : null),
    lgetxattr: (path: Buffer, name: Buffer, value: null, size: number) => {
      expect(path).toEqual(Buffer.from("/fixture\0"));
      expect(name).toEqual(Buffer.from("system.posix_acl_default\0"));
      expect(value).toBeNull();
      expect(size).toBe(0);
      return status;
    },
  };
  const attempts: unknown[] = [];
  const load = ((library: unknown) => {
    attempts.push(library);
    if (library === "libc.so.6") throw new Error("glibc unavailable");
    return { symbols };
  }) as unknown as typeof dlopen;
  const lookup = createLinuxDefaultAclCheck("linux", "x64", load);
  expect(lookup("/fixture")).toBe(false);
  expect(attempts).toEqual(["libc.so.6", "libc.musl-x86_64.so.1"]);
  hasErrno = true;
  expect(lookup("/fixture")).toBe(false);
  status = -1;
  errno[0] = constants.errno.EACCES;
  expect(lookup("/fixture")).toBe(false);
  errno[0] = constants.errno.ENODATA;
  expect(lookup("/fixture")).toBe(true);
  errno[0] = constants.errno.ENOTSUP;
  expect(lookup("/fixture")).toBe(true);
});
