package demo
import demo.Events.{emit => send}
class ScalaService extends BaseService with Runnable {
  def run(): Unit = send("🙂")
}
