export interface DeliveryPort {
  deliver(payload: string): Promise<string>;
}
