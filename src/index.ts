import { createProcessServer as createServer } from "./lifecycle";
import { BatchingStdioServerTransport } from "./stdio";

const server = createServer();

const transport = new BatchingStdioServerTransport();

await server.connect(transport);
