using JSON
export Service, run
mutable struct Service <: BaseService
end
function run()
  JSON.parse("{}")
end
