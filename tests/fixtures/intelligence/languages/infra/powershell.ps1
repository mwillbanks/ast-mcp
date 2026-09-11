using module "./Tools.psm1"
function Invoke-Task {
  $value = Get-Item "."
  Write-Output $value
}
Invoke-Task
