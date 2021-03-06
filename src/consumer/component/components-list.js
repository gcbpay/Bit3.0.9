/** @flow */
import path from 'path';
import R from 'ramda';
import Version from '../../scope/models/version';
import Component from '../component';
import { BitId } from '../../bit-id';
import logger from '../../logger/logger';
import BitMap from '../bit-map/bit-map';
import Consumer from '../consumer';
import { glob } from '../../utils';
import { COMPONENT_ORIGINS } from '../../constants';

export default class ComponentsList {
  consumer: Consumer;
  _bitMap: Object;
  _fromFileSystem: Promise<string[]>;
  _fromBitMap: Object = {};
  _fromObjects: Promise<Object<Version>>;
  constructor(consumer: Consumer) {
    this.consumer = consumer;
    this.scope = consumer.scope;
  }

  /**
   * Check whether a model representation and file-system representation of the same component is the same.
   * The way how it is done is by converting the file-system representation of the component into
   * a Version object. Once this is done, we have two Version objects, and we can compare their hashes
   */
  async isComponentModified(componentFromModel: Version, componentFromFileSystem: Component): boolean {
    const { version } = await this.consumer.scope.sources.consumerComponentToVersion(
      { consumerComponent: componentFromFileSystem, consumer: this.consumer});

    version.log = componentFromModel.log; // ignore the log, it's irrelevant for the comparison
    version.flattenedDependencies = componentFromModel.flattenedDependencies;
    // dependencies from the FS don't have an exact version, copy the version from the model
    version.dependencies.forEach((dependency) => {
      const idWithoutVersion = dependency.id.toStringWithoutVersion();
      const dependencyFromModel = componentFromModel.dependencies
        .find(modelDependency => modelDependency.id.toStringWithoutVersion() === idWithoutVersion);
      if (dependencyFromModel) {
        dependency.id = dependencyFromModel.id;
      }
    });

    // uncomment to easily understand why two components are considered as modified
    // if (componentFromModel.hash().hash !== version.hash().hash) {
    //   console.log('-------------------componentFromModel------------------------');
    //   console.log(componentFromModel.id());
    //   console.log('------------------------version------------------------------');
    //   console.log(version.id());
    //   console.log('-------------------------END---------------------------------');
    // }
    return componentFromModel.hash().hash !== version.hash().hash;
  }


  /**
   * List all objects where the id is the object-id and the value is the Version object
   * It is useful when checking for modified components where the most important data is the Ref.
   */
  async getFromObjects(): Promise<Object<Version>> {
    if (!this._fromObjects) {
      const componentsObjects = await this.scope.objects.listComponents(false);
      const componentsVersionsP = {};
      const componentsVersions = {};
      componentsObjects.forEach((componentObjects) => {
        const latestVersionRef = componentObjects.versions[componentObjects.latest()];
        const ObjId = new BitId({ scope: componentObjects.scope,
          box: componentObjects.box,
          name: componentObjects.name,
          version: componentObjects.scope ? componentObjects.latest() : null });
        componentsVersionsP[ObjId.toString()] = this.scope.getObject(latestVersionRef.hash);
      });

      const allVersions = await Promise.all(R.values(componentsVersionsP));

      Object.keys(componentsVersionsP).forEach((key, i) => {
        componentsVersions[key] = allVersions[i];
      });
      this._fromObjects = componentsVersions;
    }
    return this._fromObjects;
  }

  /**
   * Components that are in the model (either, committed from a local scope or imported), and were
   * changed in the file system
   *
   * @param {boolean} [load=false] - Whether to load the component (false will return only the id)
   * @return {Promise<string[]>}
   */
  async listModifiedComponents(load: boolean = false): Promise<string[] | Component[]> {
    const getAuthoredAndImportedFromFS = async () => {
      let [authored, imported] = await Promise.all([this.getFromFileSystem(COMPONENT_ORIGINS.AUTHORED), this.getFromFileSystem(COMPONENT_ORIGINS.IMPORTED)]);
      authored = authored || [];
      imported = imported || [];
      return authored.concat(imported);
    };

    const [objectComponents, fileSystemComponents] = await Promise
      .all([this.getFromObjects(), getAuthoredAndImportedFromFS()]);
    const objFromFileSystem = fileSystemComponents.reduce((components, component) => {
      components[component.id.toStringWithoutVersion()] = component;
      return components;
    }, {});

    const modifiedComponents = [];
    const calculateModified = Object.keys(objectComponents).map(async (id) => {
      const bitId = BitId.parse(id);
      const componentFromFS = objFromFileSystem[bitId.toStringWithoutVersion()];

      if (componentFromFS) {
        const isModified = await this.isComponentModified(objectComponents[id], componentFromFS);
        if (isModified) {
          if (load) {
            modifiedComponents.push(componentFromFS);
          } else {
            modifiedComponents.push(bitId.toStringWithoutScopeAndVersion());
          }
        }
      } else {
        logger.warn(`a component ${id} exists in the model but not on the file system`);
      }
      return Promise.resolve();
    });
    await Promise.all(calculateModified);
    return modifiedComponents;
  }

  async newAndModifiedComponents(): Promise<Component[]> {
    const [newComponents, modifiedComponents] = await Promise
      .all([this.listNewComponents(true), this.listModifiedComponents(true)]);

    const components = [...newComponents, ...modifiedComponents];

    return Promise.all(components);
  }

  async idsFromObjects(withScope: boolean = true): Promise<string[]> {
    const fromObjects = await this.getFromObjects();
    const ids = Object.keys(fromObjects);
    if (withScope) return ids;
    return ids.map(id => BitId.parse(id).toStringWithoutScopeAndVersion());
  }

  /**
   * Components that are registered in bit.map but have never been committed
   *
   * @param {boolean} [load=false] - Whether to load the component (false will return only the id)
   * @return {Promise.<string[] | Component[]>}
   * @memberof ComponentsList
   */
  async listNewComponents(load: boolean = false): Promise<string[] | Component[]> {
    const idsFromBitMap = await this.idsFromBitMap(false);
    const idsFromObjects = await this.idsFromObjects(false);
    let newComponents = [];
    idsFromBitMap.forEach((id) => {
      if (!idsFromObjects.includes(id)) {
        newComponents.push(id);
      }
    });
    if (load && newComponents.length) {
      const componentsIds = newComponents.map(id => BitId.parse(id));
      newComponents = await this.consumer.loadComponents(componentsIds);
    }
    return newComponents;
  }
  /**
   * New and modified components are commit pending
   *
   * @return {Promise<string[]>}
   */
  async listCommitPendingComponents(): Promise<string[]> {
    const [newComponents, modifiedComponents] = await Promise
      .all([this.listNewComponents(), this.listModifiedComponents()]);
    return [...newComponents, ...modifiedComponents];
  }

  /**
   * Components from the model where the scope is local are pending for export
   * Also, components that their model version is higher than their bit.map version.
   * @return {Promise<string[]>}
   */
  async listExportPendingComponents(): Promise<string[]> {
    const stagedComponents = [];
    const listFromObjects = await this.getFromObjects();
    const listFromFileSystem = await this.getFromFileSystem();
    Object.keys(listFromObjects).forEach((id) => {
      const modelBitId = BitId.parse(id);
      if (!modelBitId.scope || modelBitId.scope === this.scope.name) {
        modelBitId.scope = null;
        stagedComponents.push(modelBitId.toString());
      } else {
        const similarFileSystemComponent = listFromFileSystem
          .find(component => component.id.toStringWithoutVersion() === modelBitId.toStringWithoutVersion());
        if (similarFileSystemComponent && modelBitId.version > similarFileSystemComponent.version) {
          stagedComponents.push(modelBitId.toString());
        }
      }
    });
    return stagedComponents;
  }

  async idsFromBitMap(withScopeName = true, origin) {
    const fromBitMap = await this.getFromBitMap(origin);
    const ids = Object.keys(fromBitMap);
    if (withScopeName) return ids;
    return ids.map(id => BitId.parse(id).toStringWithoutScopeAndVersion());
  }

  async onFileSystemAndNotOnBitMap(): Promise<Component[]> {
    const { staticParts, dynamicParts } = this.consumer.dirStructure.componentsDirStructure;
    const asterisks = Array(dynamicParts.length).fill('*'); // e.g. ['*', '*', '*']
    const cwd = path.join(this.consumer.getPath(), ...staticParts);
    const bitMap = await this.getBitMap();
    const idsFromBitMap = await this.idsFromBitMap();
    const idsFromBitMapWithoutScope = await this.idsFromBitMap(false);
    const files = await glob(path.join(...asterisks), { cwd });
    const componentsP = [];
    files.forEach((componentDynamicDirStr) => {
      const rootDir = path.join(...staticParts, componentDynamicDirStr);
      // This is an imported components
      const componentFromBitMap = bitMap.getComponentObjectByRootPath(rootDir);
      if (!R.isEmpty(componentFromBitMap)) return;
      const componentDynamicDir = componentDynamicDirStr.split(path.sep);
      const bitIdObj = {};
      // combine componentDynamicDir (e.g. ['array', 'sort']) and dynamicParts
      // (e.g. ['namespace', 'name']) into one object.
      // (e.g. { namespace: 'array', name: 'sort' } )
      componentDynamicDir.forEach((dir, idx) => {
        const key = dynamicParts[idx];
        bitIdObj[key] = dir;
      });
      const parsedId = new BitId(bitIdObj);
      if (!idsFromBitMap.includes(parsedId.toString())
        && !idsFromBitMapWithoutScope.includes(parsedId.toString())) {
        componentsP.push(this.consumer.loadComponent(parsedId));
      }
    });
    return Promise.all(componentsP);
  }

  /**
   * Finds all components that are saved in the file system.
   * Components might be stored in the default component directory and also might be outside
   * of that directory. The bit.map is used to find them all
   * @return {Promise<Component[]>}
   */
  async getFromFileSystem(origin): Promise<Component[]> {
    if (!this._fromFileSystem) {
      const idsFromBitMap = await this.idsFromBitMap(undefined, origin);
      const parsedBitIds = idsFromBitMap.map(id => BitId.parse(id));
      this._fromFileSystem = await this.consumer.loadComponents(parsedBitIds);
    }
    return this._fromFileSystem;
  }

  async getFromBitMap(origin): Object {
    const cacheKeyName = origin || 'all';
    if (!this._fromBitMap[cacheKeyName]) {
      const bitMap = await this.getBitMap();
      this._fromBitMap[cacheKeyName] = bitMap.getAllComponents(origin);
    }
    return this._fromBitMap[cacheKeyName];
  }

  async getBitMap(): Object {
    if (!this._bitMap) {
      this._bitMap = await BitMap.load(this.consumer.getPath());
    }
    return this._bitMap;
  }
}
