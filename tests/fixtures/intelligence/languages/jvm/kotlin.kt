package demo
import demo.Events.emit as send
public class KotlinService() : BaseService(), Runnable {
  public fun run() { send("café") }
}
