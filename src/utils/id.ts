import { randomBytes } from "node:crypto";

function rand(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export const genResponseId = () => rand("resp");
export const genMessageId = () => rand("msg");
export const genItemId = () => rand("item");
export const genCallId = () => rand("call");
export const genPartId = () => rand("cp");
