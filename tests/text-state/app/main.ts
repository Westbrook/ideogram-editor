import '../../text/app/main';
import {DurableTextPreparation,describePrepared,releaseTextRealm} from '../../../src/text/durable';
import {textMemory} from '../../../src/text/memory';
Object.assign(window,{DurableTextPreparation,describePrepared,releaseTextRealm,textMemory});

import {RecoveryCache} from '../../../src/state/recovery-cache';
import {RecoveryConsumer} from '../../../src/state/recovery-client';
Object.assign(window,{RecoveryCache,RecoveryConsumer});
