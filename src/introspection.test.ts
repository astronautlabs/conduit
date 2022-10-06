import { expect } from "chai";
import { describe } from "razmin";
import * as webrpc from '.';
import { sessionPair } from "./testlib";

describe('introspection', it => {
    it('exposes session by default', async () => {
        let [sessionA, sessionB] = sessionPair();

        let descriptions = await sessionB.remote.describeServices();

        let matchingDescriptions = descriptions.filter(x => x.identifier === 'org.webrpc.session');
        expect(matchingDescriptions.length).to.eq(1);
        let description = matchingDescriptions[0];

        expect(description.identifier).to.eq('com.example.A');
        expect(description.version).to.eq('*');
        expect(description.author).not.to.exist;
        expect(description.description).not.to.exist;
        expect(description.summary).not.to.exist;
        expect(description.website).not.to.exist;
    });
    it('exposes a simple service', async () => {
        let [sessionA, sessionB] = sessionPair();

        @webrpc.Service('com.example.A')
        abstract class A {
            abstract info(): Promise<string>;
        }

        class AImpl extends A {
            @webrpc.Method()
            async info() {
                return 'this is A';
            }
        }

        sessionA.registerService(AImpl);
        let descriptions = await sessionB.remote.describeServices();

        let matchingDescriptions = descriptions.filter(x => x.identifier === 'com.example.A');
        expect(matchingDescriptions.length).to.eq(1);
        let description = matchingDescriptions[0];

        expect(description.identifier).to.eq('com.example.A');
        expect(description.version).to.eq('*');
        expect(description.author).not.to.exist;
        expect(description.description).not.to.exist;
        expect(description.summary).not.to.exist;
        expect(description.website).not.to.exist;
    });
});