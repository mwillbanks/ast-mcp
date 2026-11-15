import { dlopen, FFIType, read } from "bun:ffi";
import { constants } from "node:os";

// Darwin public SDK: ACL_TYPE_EXTENDED and MNT_IGNORE_OWNERSHIP.
const extendedAcl = 0x100;
const ignoreOwnership = 0x00200000;

function loadMacFileAccess(platform: NodeJS.Platform, load: typeof dlopen) {
  if (platform !== "darwin") return undefined;
  try {
    return load("/usr/lib/libSystem.B.dylib", {
      __error: { args: [], returns: FFIType.ptr },
      acl_free: { args: [FFIType.ptr], returns: FFIType.i32 },
      acl_get_link_np: {
        args: [FFIType.cstring, FFIType.i32],
        returns: FFIType.ptr,
      },
      statfs: {
        args: [FFIType.cstring, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
  } catch {
    return undefined;
  }
}

export function createMacFileAccess(
  platform = process.platform,
  load = dlopen,
) {
  const system = loadMacFileAccess(platform, load);
  const statfsBuffer = new Uint8Array(4096);
  const statfsInfo = new DataView(statfsBuffer.buffer);

  function macPathHasNoAcl(filePath: string): boolean {
    if (!system) return false;
    const { __error, acl_free, acl_get_link_np } = system.symbols;
    const acl = acl_get_link_np(Buffer.from(filePath + "\0"), extendedAcl);
    if (acl) {
      acl_free(acl);
      return false;
    }
    const errno = __error();
    // The caller already verified this path exists and is not a symlink.
    return errno !== null && read.i32(errno, 0) === constants.errno.ENOENT;
  }

  function macVolumeEnforcesOwnership(filePath: string): boolean {
    if (!system) return false;
    if (system.symbols.statfs(Buffer.from(filePath + "\0"), statfsBuffer) !== 0)
      return false;
    // Offset of f_flags in Darwin's 64-bit statfs structure.
    return (statfsInfo.getUint32(64, true) & ignoreOwnership) === 0;
  }

  return { macPathHasNoAcl, macVolumeEnforcesOwnership };
}

export const { macPathHasNoAcl, macVolumeEnforcesOwnership } =
  createMacFileAccess();
