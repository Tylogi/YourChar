import type { DeliveryPort } from "./port.js";

export class QueueDeliveryPort implements DeliveryPort {
  async deliver(_payload: string): Promise<string> {
    return "QUEUE_ENQUEUED";
  }
}
