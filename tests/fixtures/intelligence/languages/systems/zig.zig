const std = @import("std");
pub const Service = struct { pub fn run() void { std.debug.print("café", .{}); } };
