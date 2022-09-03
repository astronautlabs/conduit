import { Message } from "./message";

export interface EventMessage {
    type: 'event';
    receiver: any;
    name: string;
    object: any;
}

export function isEventMessage(message: Message): message is EventMessage {
    return message.type === 'event';
}
