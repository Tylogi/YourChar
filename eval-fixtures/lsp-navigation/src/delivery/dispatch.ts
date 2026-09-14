import type { DeliveryPort } from "./port.js";

export async function dispatch(port: DeliveryPort, payload: string): Promise<string> {
  return port.deliver(payload);
}
