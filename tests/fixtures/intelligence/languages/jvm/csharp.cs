using Events = Demo.Events;
namespace Demo;
public class CSharpService : BaseService, IRunnable {
  public void Run() { Events.Emit("🙂"); }
}
