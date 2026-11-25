import { XRDevice, metaQuest3 } from 'iwer';
const d = new XRDevice(metaQuest3);
d.installRuntime();
d.position.set(0, 1.6, 0);
window.__dev = d;
