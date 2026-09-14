// Structural look-alike intentionally does not implement DeliveryPort.
export class ShadowDeliveryPort {
  async deliver(_payload: string): Promise<string> {
    return "SHADOW_ONLY";
  }
}
