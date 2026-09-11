library("methods")
Service <- function() {
  print("ok")
}
setClass("Child", contains = "Base")
