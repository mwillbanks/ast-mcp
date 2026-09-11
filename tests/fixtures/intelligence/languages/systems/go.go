package demo
import "fmt"
type Service struct{}
func (Service) Run() { fmt.Println("café") }
func helper() {}
