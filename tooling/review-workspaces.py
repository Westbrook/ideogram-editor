#!/usr/bin/env python3
"""Read-only inventory. Age and allocated bytes never establish safe deletion."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def within(path, directory):
    return path == directory or directory in path.parents


def known_locations(parent, repo):
    protected = [(repo.resolve(), 'current checkout'),
                 (parent / 'ideogram-edit-progress-report', 'progress report')]
    warnings = []
    state = parent / 'ideogram-edit-progress-report/data/project.json'
    locator = repo / '.progress-report/project.json'
    try:
        if locator.exists():
            location = json.loads(locator.read_text()).get('stateLocation')
            if location and (repo / location).is_file():
                state = (repo / location).resolve()
        if not state.is_file():
            return protected, ['Report state unavailable; active preview locations are unknown.']
        data = json.loads(state.read_text())
        protected.append((state.parent.parent, 'progress report'))
        current = [c for c in data.get('cards', []) if c.get('current', True)]
        identities = {(c.get('itemId'), c.get('version')) for c in current}
        records = current + [d for d in data.get('deliverables', [])
                             if (d.get('itemId'), d.get('version')) in identities]
        records += list(data.get('project', {}).get('apps', {}).values())
        for record in records:
            service = record.get('previewIdentity', {}).get('service', record.get('service', {}))
            for key in ('root', 'privateRoot'):
                location = service.get(key)
                if isinstance(location, str) and Path(location).is_absolute():
                    protected.append((Path(location).resolve(), 'preview referenced by current report'))
    except (OSError, ValueError, TypeError, AttributeError) as error:
        warnings.append(f'Report metadata incomplete: {error}')
    return protected, warnings


def inventory(parent, repo=ROOT, now=None, run=subprocess.run):
    parent = parent.expanduser().resolve(strict=True)
    repo = repo.resolve()
    now = time.time() if now is None else now
    protected, warnings = known_locations(parent, repo)
    errors, worktrees, rows, skipped = [], [], [], []
    result = run(['git', '-C', str(repo), 'worktree', 'list', '--porcelain', '-z'],
                 capture_output=True, text=True)
    if result.returncode:
        errors.append('Worktree metadata unavailable: ' + result.stderr.strip())
    else:
        worktrees = [Path(field[len('worktree '):]).resolve() for field in result.stdout.split('\0')
                     if field.startswith('worktree ')]
    for path in parent.iterdir():
        if not path.name.startswith('ideogram-edit-'):
            continue
        try:
            if path.is_symlink():
                skipped.append(str(path))
                continue
            if not path.is_dir():
                continue
            stat = path.stat()
            reasons = sorted({reason for location, reason in protected
                              if within(location, path) or within(path, location)})
            row = dict(path=str(path), allocated_bytes=None,
                       modified_at=datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                       age_days=round(max(0, now - stat.st_mtime) / 86400, 2),
                       worktrees=[str(w) for w in worktrees if within(w, path)],
                       exclusions=reasons, candidate=not reasons)
            # -P does not follow symlinks. du measures allocated KiB, not apparent size.
            size = run(['du', '-skP', str(path)], capture_output=True, text=True)
            if size.returncode:
                row['error'] = size.stderr.strip() or f'du exited {size.returncode}'
                errors.append(f'{path}: {row["error"]}')
            else:
                row['allocated_bytes'] = int(size.stdout.split()[0]) * 1024
            rows.append(row)
        except (OSError, ValueError, IndexError) as error:
            errors.append(f'{path}: {error}')
    rows.sort(key=lambda row: (-(row['allocated_bytes'] or 0), row['path']))
    measured = [row for row in rows if row['allocated_bytes'] is not None]
    return dict(parent=str(parent), scanned_at=datetime.fromtimestamp(now, timezone.utc).isoformat(),
                directories=rows, skipped_symlinks=skipped, warnings=warnings, errors=errors,
                complete=not errors,
                totals=dict(directories=len(rows), measured=len(measured),
                            allocated_bytes=sum(row['allocated_bytes'] for row in measured),
                            candidate_bytes=sum(row['allocated_bytes'] for row in measured if row['candidate']),
                            excluded_bytes=sum(row['allocated_bytes'] for row in measured if not row['candidate'])),
                caveat='Directory mtime is only an age heuristic. Candidates need user confirmation of inactivity, unique work and retained evidence. Allocated bytes are an upper bound, not guaranteed reclaimable space; unknown services and filesystem sharing are not detected. Nothing is deleted.')


def render(report):
    print(f'Review directory audit: {report["parent"]}')
    print('GiB       Age days  Modified (UTC)             Directory / classification')
    for row in report['directories']:
        size = f'{row["allocated_bytes"] / 1024**3:9.3f}' if row['allocated_bytes'] is not None else '  unknown'
        status = '; '.join(row['exclusions']) or 'candidate, inactivity unverified'
        print(f'{size}  {row["age_days"]:8.2f}  {row["modified_at"][:19]}Z  {row["path"]} [{status}]')
        for worktree in row['worktrees']:
            print(f'    Registered worktree: {worktree}')
    totals = report['totals']
    print(f'\nMeasured {totals["measured"]}/{totals["directories"]} directories: '
          f'{totals["allocated_bytes"] / 1024**3:.3f} GiB total; '
          f'{totals["candidate_bytes"] / 1024**3:.3f} GiB candidates; '
          f'{totals["excluded_bytes"] / 1024**3:.3f} GiB known exclusions.')
    for path in report['skipped_symlinks']:
        print(f'Skipped symlink: {path}')
    for warning in report['warnings']:
        print(f'Warning: {warning}')
    for error in report['errors']:
        print(f'INCOMPLETE: {error}')
    print(report['caveat'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--parent', type=Path, default=Path.home() / 'Documents/repos')
    parser.add_argument('--json', action='store_true', help='Print the inventory as JSON')
    args = parser.parse_args()
    try:
        report = inventory(args.parent)
    except OSError as error:
        parser.exit(1, f'Cannot audit directories: {error}\n')
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        render(report)
    return 0 if report['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
