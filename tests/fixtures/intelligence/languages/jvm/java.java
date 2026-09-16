package demo;
import java.util.List;
import static demo.Events.emit;
public class CaféService extends BaseService implements Runnable, AutoCloseable {
  public void run() { emit("🙂"); helper(); }
  private void helper() {}
}
