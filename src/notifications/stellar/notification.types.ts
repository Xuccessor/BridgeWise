/**
 * Notification types for Stellar bridge transfers
 */
export type NotificationType =
  | 'transfer.initiated'
  | 'transfer.locked'
  | 'transfer.validated'
  | 'transfer.submitted'
  | 'transfer.confirmed'
  | 'transfer.completed'
  | 'transfer.failed'
  | 'transfer.refunded'
  | 'transfer.delayed'
  | 'bridge.warning';

/**
 * Notification channels for delivery
 */
export enum NotificationChannel {
  WEBHOOK = 'webhook',
  EMAIL = 'email',
  UI_ALERT = 'ui_alert',
  PUSH = 'push',
  SMS = 'sms',
}

/**
 * Notification priority levels
 */
export enum NotificationPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

/**
 * Transfer notification payload
 */
export interface TransferNotification {
  notificationId: string;
  transferId: string;
  type: NotificationType;
  priority: NotificationPriority;
  timestamp: number;
  sourceChain: string;
  destinationChain: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  assetCode: string;
  status: string;
  message: string;
  details?: Record<string, unknown>;
  channels: NotificationChannel[];
  delivered?: boolean;
  deliveryAttempts?: number;
}

/**
 * Webhook event for transfer notifications
 */
export interface WebhookEvent {
  id: string;
  type: NotificationType;
  timestamp: number;
  data: TransferNotification;
}

/**
 * UI alert notification
 */
export interface UIAlert {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
  actions?: AlertAction[];
}

/**
 * Action associated with a UI alert
 */
export interface AlertAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

/**
 * Notification subscriber
 */
export interface NotificationSubscriber {
  subscriberId: string;
  address: string;
  channels: NotificationChannel[];
  webhookUrl?: string;
  email?: string;
  phoneNumber?: string;
  preferences: NotificationPreferences;
  createdAt: number;
  isActive: boolean;
}

/**
 * Notification delivery preferences
 */
export interface NotificationPreferences {
  notifyOnInitiation: boolean;
  notifyOnCompletion: boolean;
  notifyOnFailure: boolean;
  notifyOnDelay: boolean;
  minAmountToNotify?: string;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  unsubscribedTypes?: NotificationType[];
}

/**
 * Notification delivery receipt
 */
export interface DeliveryReceipt {
  receiptId: string;
  notificationId: string;
  channel: NotificationChannel;
  status: DeliveryStatus;
  deliveredAt?: number;
  failureReason?: string;
  retryCount: number;
  nextRetryAt?: number;
}

/**
 * Delivery status
 */
export enum DeliveryStatus {
  PENDING = 'pending',
  DELIVERED = 'delivered',
  FAILED = 'failed',
  BOUNCED = 'bounced',
  READ = 'read',
}

/**
 * Configuration for notification service
 */
export interface NotificationServiceConfig {
  maxRetries: number;
  retryDelayMs: number;
  webhookTimeoutMs: number;
  enableWebhooks: boolean;
  enableEmailNotifications: boolean;
  enableUIAlerts: boolean;
  maxNotificationsInMemory: number;
}

/**
 * Statistics for notification delivery
 */
export interface NotificationStats {
  totalNotifications: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  averageDeliveryTimeMs: number;
  subscriberCount: number;
}
