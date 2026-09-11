package demo
import demo.Events as Events
public class GroovyService extends BaseService implements Runnable {
  public def run() { Events.emit("café") }
}
