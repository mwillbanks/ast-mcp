---
title: Café design
status: accepted
---

# Overview

See [guide](https://example.test/guide), [[Architecture]], ADR-0042, RFC 9110, @scope/package, and `Widget`.

| Name   | State |
| ------ | ----- |
| Widget | ready |

## Code

```ts
interface Runnable {
  run(): string;
}
declare class Base {}
export class Widget extends Base implements Runnable {
  run() {
    return build("🙂");
  }
}
```
