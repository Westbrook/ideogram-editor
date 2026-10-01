import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {caseIdentity, normalizeCasePath, contractsForCase} from './selectors.mjs';

export default class DeveloperBrowserReporter {
  records = []; occurrences = new Map(); expected = []; begun = false;
  onBegin(config, suite) {
    this.begun = true;
    this.expected = suite.allTests().map(test => test.id);
    this.records.push({type: 'discovery', ids: this.expected, files: [...new Set(suite.allTests().map(test => normalizeCasePath(process.cwd(), test.location.file)))], cases: this.expected.length, workers: config.workers});
  }
  onTestEnd(test, result) {
    const file = normalizeCasePath(process.cwd(), test.location.file), name = test.title;
    const key = JSON.stringify([file, name]), occurrence = (this.occurrences.get(key) ?? 0) + 1; this.occurrences.set(key, occurrence);
    this.records.push({type: 'case', id: caseIdentity('B', file, name, occurrence), frameworkId: test.id, method: 'B', file, name, titlePath: test.titlePath(), occurrence,
      contracts: contractsForCase('B', file, name, occurrence), line: test.location.line, column: test.location.column, status: result.status, expectedStatus: test.expectedStatus,
      retry: result.retry, durationMs: result.duration, browserProject: test.titlePath()[1] ?? ''});
  }
  onEnd(result) {
    const observed = this.records.filter(item => item.type === 'case');
    this.records.push({type: 'end', status: this.begun && this.expected.length > 0 && result.status === 'passed' && observed.length === this.expected.length && new Set(observed.map(item => item.frameworkId)).size === this.expected.length && this.expected.every(id => observed.some(item => item.frameworkId === id)) && observed.every(item => item.retry === 0 && item.status === 'passed') ? 'passed' : 'failed'});
    mkdirSync(dirname(process.env.QUALIFICATION_CASE_REPORT), {recursive: true});
    writeFileSync(process.env.QUALIFICATION_CASE_REPORT, this.records.map(record => JSON.stringify(record)).join('\n') + '\n', {flag: 'wx'});
  }
}
