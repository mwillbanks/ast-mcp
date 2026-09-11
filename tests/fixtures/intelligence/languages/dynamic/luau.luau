local Service = require(script.Parent.Service)
export type Result = { ok: boolean }
local function run()
  Service.new()
end
return run
