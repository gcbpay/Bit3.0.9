/** @flow */
import { inflateSync } from 'zlib';
import Repository from './repository';
import { deflate, inflate, sha1 } from '../../utils';
import { NULL_BYTE, SPACE_DELIMITER } from '../../constants';
import Ref from './ref';

function parse(buffer: Buffer, types: {[string]: Function}): BitObject {
  const firstNullByteLocation = buffer.indexOf(NULL_BYTE);
  const headers = buffer.slice(0, firstNullByteLocation).toString();
  const contents = buffer.slice(firstNullByteLocation+1, buffer.length);
  const [type, ] = headers.split(SPACE_DELIMITER);

  return types[type].parse(contents);
}

export default class BitObject {
  id(): string {
    throw new Error('id() was not implemented...');
  }

  toBuffer(): Buffer {
    throw new Error('toBuffer() was not implemented...');
  }

  static parse(data: *) { // eslint-disable-line no-unused-vars
    throw new Error('parse() was not implemented...');
  }

  refs(): Ref[] {
    return [];
  }

  get header(): string {
    return `${this.constructor.name} ${this.hash().toString()} ${this.toBuffer().toString().length}${NULL_BYTE}`;
  }

  collectRefs(repo: Repository): Ref[] {
    const refsCollection = [];

    function addRefs(object: BitObject) {
      const refs = object.refs();
      const objs = refs.map((ref) => {
        return ref.loadSync(repo);
      });

      refsCollection.push(...refs);
      objs.forEach(obj => addRefs(obj));
    }

    addRefs(this);
    return refsCollection;
  }

  collectRaw(repo: Repository): Promise<Buffer[]> {
    return Promise.all(this
      .collectRefs(repo)
      .map(ref => ref.loadRaw(repo)
    ));
  }

  asRaw(repo: Repository): Promise<Buffer> {
    return repo.loadRaw(this.hash());
  }

  collect(repo: Repository): BitObject[] {
    const objects = [];

    function addRefs(object: BitObject) {
      const objs = object.refs().map((ref) => {
        return ref.loadSync(repo);
      });

      objects.push(...objs);
      objs.forEach(obj => addRefs(obj));
    }

    addRefs(this);
    return objects;
  }

  /**
   * indexing method
   */
  hash(): Ref {
    // console.log(`sha ${sha1(this.id())}, id ${this.id()}`); // uncomment when debugging hash issues
    return new Ref(sha1(this.id()));
  }

  compress(): Promise<Buffer> {
    return deflate(this.serialize());
  }

  serialize(): Buffer {
    return Buffer.concat([new Buffer(this.header), this.toBuffer()]);
  }

  static parseObject(fileContents: Buffer, types: {[string]: Function}): Promise<BitObject> {
    return inflate(fileContents)
      .then(buffer => parse(buffer, types));
  }

  static parseSync(fileContents: Buffer, types: {[string]: Function}): BitObject {
    const buffer = inflateSync(fileContents);
    return parse(buffer, types);
  }
}
