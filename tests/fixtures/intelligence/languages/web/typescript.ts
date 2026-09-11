import { emit as send } from "./client.ts";
import type { Runnable } from "./types.ts";

declare class Base {}
export interface Named {
  name: string;
}
export class Service extends Base implements Runnable, Named {
  name = "🙂";
  run(value: string) {
    return send(value);
  }
}
export { Service as DefaultService };
