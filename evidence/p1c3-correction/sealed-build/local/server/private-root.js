import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
export class PrivateRootError extends Error {
    constructor() { super('Use an owner-only storage directory with no symbolic links (0700 directories, 0600 files).'); }
}
export async function checkPath(path) {
    if (!isAbsolute(path) || path.split(sep).includes('..'))
        throw new PrivateRootError();
    let current = parse(path).root;
    for (const part of relative(current, path).split(sep).filter(Boolean)) {
        current = join(current, part);
        const stat = await lstat(current);
        if (stat.isSymbolicLink())
            throw new PrivateRootError();
    }
}
export async function assertSeparateDirectories(privatePath, staticPath) {
    async function ancestors(path) {
        // Reject symlinks before walking actual filesystem identities. Spelling
        // comparisons miss case/Unicode aliases on filesystems that support them.
        await checkPath(path);
        const identities = [];
        for (let current = resolve(path);; current = dirname(current)) {
            const stat = await lstat(current, { bigint: true });
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new PrivateRootError();
            identities.push(`${stat.dev}:${stat.ino}`);
            if (dirname(current) === current)
                return identities;
        }
    }
    const [privateAncestors, staticAncestors] = await Promise.all([ancestors(privatePath), ancestors(staticPath)]);
    if (privateAncestors.includes(staticAncestors[0]) || staticAncestors.includes(privateAncestors[0])) {
        throw new Error('The trusted browser build and private storage must be separate.');
    }
}
export async function preparePrivateRoot(input) {
    // POSIX permissions are qualified here. Do not pretend mode bits secure Windows ACLs.
    if (process.platform === 'win32' || !process.getuid || !isAbsolute(input) || input.split(sep).includes('..'))
        throw new PrivateRootError();
    const path = resolve(input);
    let current = parse(path).root;
    for (const part of relative(current, path).split(sep).filter(Boolean)) {
        current = join(current, part);
        await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST')
            throw error; });
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new PrivateRootError();
    }
    const identity = await lstat(path);
    if (identity.uid !== process.getuid() || (identity.mode & 0o777) !== 0o700)
        throw new PrivateRootError();
    async function assertUnchanged() {
        await checkPath(path);
        const now = await lstat(path);
        if (!now.isDirectory() || now.dev !== identity.dev || now.ino !== identity.ino || now.uid !== identity.uid || (now.mode & 0o777) !== 0o700)
            throw new PrivateRootError();
    }
    async function recordLaunch(origin) {
        await assertUnchanged();
        const file = await open(join(path, 'launch.json'), constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== identity.uid || (stat.mode & 0o777) !== 0o600)
                throw new PrivateRootError();
            await file.truncate(0);
            await file.writeFile(JSON.stringify({ protocolVersion: 1, origin, pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
            await file.sync();
            await assertUnchanged();
        }
        finally {
            await file.close();
        }
    }
    return { path, assertUnchanged, recordLaunch };
}
