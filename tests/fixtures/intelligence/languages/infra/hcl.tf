resource "aws_s3_bucket" "logs" {
  source = "./module"
  name = format("%s-logs", var.prefix)
}
