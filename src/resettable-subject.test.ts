import { expect } from "chai";
import { delay, describe } from "razmin";
import { ResettableReplaySubject } from "./resettable-subject";

describe('ResettableReplaySubject', it => {
    it('works', async () => {
        let subj = new ResettableReplaySubject<void>(1);
        let emitted = 0;
        let obs = subj.asObservable();

        obs.subscribe(() => emitted += 1);
        expect(emitted).to.equal(0);
        subj.next();
        expect(emitted).to.equal(1);
        obs.subscribe(() => emitted += 1);
        expect(emitted).to.equal(2);
        subj.reset();
        obs.subscribe(() => emitted += 1);
        expect(emitted).to.equal(2);
        subj.next();
        expect(emitted).to.equal(5);
        subj.next();
        expect(emitted).to.equal(8);
    });
    it('retains values', async () => {
        let subj = new ResettableReplaySubject<number>(3);
        let emitted = 0;
        let obs = subj.asObservable();

        obs.subscribe(i => emitted += 1 + i);
        expect(emitted).to.equal(0);
        subj.next(1);
        expect(emitted).to.equal(2);
        subj.next(2);
        expect(emitted).to.equal(5);
        subj.next(3);
        expect(emitted).to.equal(9);
        obs.subscribe(i => emitted += (2 + i));
        expect(emitted).to.equal(21);

        subj.next(4)
        expect(emitted).to.equal(32);

        subj.reset();

        obs.subscribe(i => emitted += 3 + i);
        expect(emitted).to.equal(32);

        subj.next(1);
        expect(emitted).to.equal(41);
        subj.next(0);
        expect(emitted).to.equal(47);
    })
    it('limits buffer', async () => {
        
        let subj = new ResettableReplaySubject<number>(3);
        let emitted = 0;
        let obs = subj.asObservable();

        obs.subscribe(i => emitted += i);
        expect(emitted).to.equal(0);

        subj.next(1);
        subj.next(2);
        subj.next(3);
        subj.next(4);

        expect(emitted).to.equal(10);

        obs.subscribe(i => emitted += 2 + i);

        expect(emitted).to.equal(25);
    });
});