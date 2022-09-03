import { Message } from "./message";

export interface Response {
    type: 'response';
    id: string;
    error: any;
    value: any;
}

export function isResponse(message: Message): message is Response {
    return message.type === 'response';
}
