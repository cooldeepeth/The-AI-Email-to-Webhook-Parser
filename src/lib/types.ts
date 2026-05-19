/** Subset of Postmark's inbound webhook payload that we rely on. */
export interface PostmarkInboundPayload {
  FromName?: string;
  From?: string;
  FromFull?: { Email?: string; Name?: string };
  To?: string;
  ToFull?: Array<{ Email?: string; Name?: string; MailboxHash?: string }>;
  Cc?: string;
  Subject?: string;
  MessageID?: string;
  Date?: string;
  TextBody?: string;
  HtmlBody?: string;
  StrippedTextReply?: string;
  Attachments?: Array<{
    Name?: string;
    ContentType?: string;
    ContentLength?: number;
    ContentID?: string;
  }>;
  Headers?: Array<{ Name: string; Value: string }>;
  [key: string]: unknown;
}

export type WebhookLogStatus =
  | "received"
  | "processing"
  | "success"
  | "failed_ai"
  | "failed_delivery";

export interface EndpointRow {
  id: string;
  user_id: string;
  name: string;
  inbound_email_slug: string;
  target_webhook_url: string;
  webhook_secret: string;
  ai_prompt_schema: string;
  is_active: boolean;
}
