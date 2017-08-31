/** @flow */
import Command from '../../command';
import ComponentObjects from '../../../scope/component-objects';
import { fromBase64, buildCommandMessage, packCommand, unpackCommand } from '../../../utils';
import { put } from '../../../api/scope';
import logger from '../../../logger/logger';

export default class Put extends Command {
  name = '_put <path> <args>';
  private = true;
  description = 'upload a component to a scope';
  alias = '';
  opts = [];

  action([path, ]: [string, string]): Promise<any> {
    logger.debug('_put in action');
    let data = '';
    return new Promise((resolve, reject) => {
      process.stdin
        .on('data', (chunk) => {
          data += chunk.toString();
        })
        .on('end', () => {
          return put({ componentObjects: fromBase64(data.toString()), path: fromBase64(path) })
            .then(resolve).catch(reject);
        });
    });
  }

  report(componentObjects: ComponentObjects): string {
    logger.debug('_put in report');
    const compsStr = ComponentObjects.manyToString(componentObjects);
    const compsStrPacked = packCommand(buildCommandMessage(compsStr));
    const compsStrUnpacked = unpackCommand(compsStrPacked); // observe that it is able to parse the json at this step
    // logger.debug(`_put before sending ${compsStrPacked}`);
    logger.debug(`_put before sending length ${compsStrPacked.length}`);
    return packCommand(buildCommandMessage(ComponentObjects.manyToString(componentObjects)));
  }
}
