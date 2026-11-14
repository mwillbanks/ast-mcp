import { dlopen, FFIType, read } from "bun:ffi";
import { constants } from "node:os";

const defaultAcl = Buffer.from("system.posix_acl_default\0");
const functions = {
  __errno_location: { args: [], returns: FFIType.ptr },
  lgetxattr: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64_fast],
    returns: FFIType.i64_fast,
  },
} as const;

function loadLinuxFileAccess(arch: string, load: typeof dlopen) {
  try {
    return load("libc.so.6", functions);
  } catch {
    // The standalone Linux packages also support musl.
    const muslArch = arch === "arm64" ? "aarch64" : "x86_64";
    try {
      return load(`libc.musl-${muslArch}.so.1`, functions);
    } catch {
      return null;
    }
  }
}

export function createLinuxDefaultAclCheck(
  platform = process.platform,
  arch: string = process.arch,
  load = dlopen,
) {
  let system: ReturnType<typeof loadLinuxFileAccess> | undefined;
  return (directory: string): boolean => {
    if (platform !== "linux") return false;
    if (system === undefined) system = loadLinuxFileAccess(arch, load);
    if (!system) return false;
    const { __errno_location, lgetxattr } = system.symbols;
    const errno = __errno_location();
    if (
      !errno ||
      lgetxattr(Buffer.from(directory + "\0"), defaultAcl, null, 0) !== -1
    )
      return false;
    const code = read.i32(errno);
    // No default ACL, or the filesystem does not support POSIX ACLs.
    return code === constants.errno.ENODATA || code === constants.errno.ENOTSUP;
  };
}

export const linuxDirectoryHasNoDefaultAcl = createLinuxDefaultAclCheck();
