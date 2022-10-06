import { Session } from "../session";
import { TestChannel } from "./test-channel";

export function sessionPair() {
    let [channelA, channelB] = TestChannel.makePair();
    let sessionA = new Session(channelA);
    let sessionB = new Session(channelB);

    sessionA.tag = 'A';
    sessionB.tag = 'B';

    return [sessionA, sessionB];
}