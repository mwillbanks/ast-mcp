import { Base as Parent } from "./base.js";
export class CaféService extends Parent {
  run(value) {
    return emit(value);
  }
}
export const factory = () => new CaféService();
