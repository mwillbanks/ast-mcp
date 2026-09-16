import demo.Events;
public with sharing class ApexService extends BaseService implements Runnable {
  public void run() { Events.emit('café'); }
}
