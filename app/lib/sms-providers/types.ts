import type { DeliveryReport } from "../termii.ts";

export type SmsCredentials = Record<string, string>;
export type SmsSendInput = { phones: string[]; senderId: string; message: string; channel: "generic" | "dnd" };
export type SmsRecipientResult = { phone: string; status: "accepted" | "failed" | "unknown"; providerId: string | null; reason?: string };
export type SmsBalance = { balance: number; currency: string; unit: "money" | "credits" };
export type SmsAdapter = {
  balance(credentials: SmsCredentials): Promise<SmsBalance>;
  send(credentials: SmsCredentials, input: SmsSendInput): Promise<SmsRecipientResult[]>;
  reports?(credentials: SmsCredentials, providerId: string): Promise<DeliveryReport[]>;
};
