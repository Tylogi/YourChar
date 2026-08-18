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
};

export type DeliveryResult = {
  delivered: boolean;
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

  async deliver(notification: NotificationDelivery): Promise<DeliveryResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "notify-send",
        ["--app-name", "YourChar", notification.title, notification.body],
        { stdio: "ignore" },
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
