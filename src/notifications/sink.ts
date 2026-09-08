import { spawn } from "node:child_process";

export type NotificationDelivery = {
  outboxId: string;
  occurrenceId: string;
  scheduleItemId: string;
  title: string;
  body: string;
  dueAt: string;
  sourceSessionId?: string;
  agentGenerated: boolean;
  eventAt?: string;
  timezone?: string;
};

export type DeliveryResult = {
  delivered: boolean;
  pending?: boolean;
  detail?: string;
};

export interface NotificationSink {
  readonly channel: string;
  deliver(notification: NotificationDelivery): Promise<DeliveryResult>;
}

export class InAppNotificationSink implements NotificationSink {
  readonly channel = "in_app";

  async deliver(): Promise<DeliveryResult> {
    return { delivered: true, detail: "stored in notification history" };
  }
}

export class CaptureNotificationSink implements NotificationSink {
  readonly channel = "capture";
  readonly deliveries: NotificationDelivery[] = [];

  async deliver(notification: NotificationDelivery): Promise<DeliveryResult> {
    this.deliveries.push(structuredClone(notification));
    return { delivered: true, detail: "captured" };
  }
}

export class NotifySendNotificationSink implements NotificationSink {
  readonly channel = "desktop";
  constructor(private readonly enabled = true) {}

  async deliver(notification: NotificationDelivery): Promise<DeliveryResult> {
    if (!this.enabled) return { delivered: false, detail: "桌面通知未启用（RP_AGENT_DESKTOP_NOTIFICATIONS=1）；这是服务器桌面通知，不是浏览器推送" };
    return new Promise((resolve, reject) => {
      const child = spawn(
        "notify-send",
        ["--app-name", "YourChar", notification.title, notification.body],
        { stdio: "ignore", timeout: 4000 },
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolve({ delivered: true, detail: "notify-send" });
        } else {
          reject(new Error(`notify-send exited with code ${String(code)}`));
        }
      });
    });
  }
}

export function createDefaultNotificationSink(): NotificationSink {
  return process.env.RP_AGENT_DESKTOP_NOTIFICATIONS === "1"
    ? new NotifySendNotificationSink()
    : new InAppNotificationSink();
}
