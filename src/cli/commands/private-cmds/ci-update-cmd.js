/** @flow */
import Command from '../../command';
import { ciUpdateAction } from '../../../api/scope';
import SpecsResults from '../../../consumer/specs-results/specs-results';
import { paintSpecsResults } from '../../chalk-box';

export default class CiUpdate extends Command {
  name = 'ci-update <id> [scopePath]';
  description = 'run an update for build and test of a certain bit-component';
  alias = '';
  opts = [
    ['v', 'verbose', 'showing npm verbose output for inspection'],
    ['t', 'testDir <file>', 'directory to run ci-update'],
    ['k', 'keep', 'keep test environment after run (default false)'],
    ['s', 'save <file>', 'save ci results   to file system']
  ];
  private = true;

  action([id, scopePath]: [string, ?string, ], { verbose, testDir, save , keep = false }: { verbose: ?boolean, testDir: ?string, save: ?string, keep:boolean }): Promise<any> {
    verbose = true; // During ci-update we always want to see verbose outputs
    return ciUpdateAction(id, scopePath || process.cwd(), verbose, testDir, keep);
  }

  report(maybeSpecsResults: SpecsResults|Error): string {
    if (!maybeSpecsResults) { return 'no results found'; }

    if (maybeSpecsResults instanceof Error) {
      return maybeSpecsResults.message;
    }

    return paintSpecsResults(maybeSpecsResults);
  }
}
