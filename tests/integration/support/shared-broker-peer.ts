import {
  runSharedBroker,
  standaloneBrokerLifetime,
} from "../../../src/server/shared-broker/broker";

const [installationKey, mode] = process.argv.slice(2);
if (!installationKey) throw new Error("Missing broker fixture identity");

await runSharedBroker({
  installationKey,
  lifetime: standaloneBrokerLifetime(),
  onListening(port) {
    if (mode) console.log(port);
  },
  async connectSession(transport) {
    transport.onmessage = (message) => {
      if (!("id" in message) || !("method" in message)) return;
      if (mode === "watchdog") setInterval(() => {}, 1_000);
      void transport
        .send({
          id: message.id,
          jsonrpc: "2.0",
          result:
            mode === "backpressure"
              ? { tail: "x".repeat(4 * 1024 * 1024) }
              : { pid: process.pid },
        })
        .catch(() => {
          // EOF rejects pending writes even when their queued bytes can flush.
        });
    };
    await transport.start();
    return transport;
  },
});
