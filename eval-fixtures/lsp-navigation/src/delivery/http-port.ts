import type { DeliveryPort } from "./port.js";

export class HttpDeliveryPort implements DeliveryPort {
  async deliver(_payload: string): Promise<string> {
    return "HTTP_ACCEPTED";
  }
}
