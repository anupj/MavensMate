'use strict';
var Q                 = require('q');
var tmp               = require('tmp');
var _                 = require('lodash');
var swig              = require('swig');
var fs                = require('fs-extra');
var path              = require('path');
var util              = require('./util').instance;
var uuid              = require('node-uuid');
var SalesforceClient  = require('./sfdc-client');
var Metadata          = require('./metadata').Metadata;
var MetadataService   = require('./metadata').MetadataService;
var Deploy            = require('./deploy');
var xmldoc            = require('xmldoc');
var find              = require('findit');
var config            = require('./config');
var logger            = require('winston');
var IndexService      = require('./index');

Q.longStackSupport = true;

/**
 * Represents a MavensMate project
 *
 * @constructor
 * @param {Object} [opts] - Options used in deployment
 * @param {String} [opts.projectName] - For new projects, sets the name of the project
 * @param {String} [opts.subscription] - (optional) Specifies list of Metadata types that the project should subscribe to
 * @param {String} [opts.workspace] - (optional) For new projects, sets the workspace
 * @param {String} [opts.path] - (optional) Explicitly sets path of the project (defaults to current working directory)
 * @param {Array} [opts.packages] - List of packages
 */
function Project(opts) {
  util.applyProperties(this, opts);
  swig.setDefaults({ runInVm: true, loader: swig.loaders.fs(path.join(__dirname,'templates')) });
}

/**
 * Initializes project instance based on whether this is a new or existing project
 * @param  {Boolean} isNewProject
 * @return {Promise}
 */
Project.prototype.initialize = function(isNewProject) {
  var deferred = Q.defer();
  var self = this;

  if (isNewProject === undefined) {
    isNewProject = false;
  }

  var isExistingProject = !isNewProject; // for readability :^)

  if (isExistingProject) {  
    self._initExisting()
      .then(function() {
        deferred.resolve(self);
      })
      ['catch'](function(error) {
        deferred.reject(new Error('Could not initiate existing Project instance: '+error));
      })
      .done(); 
  }

  else if (isNewProject) {
    self._initNew()
      .then(function() {
        deferred.resolve(self);
      })
      ['catch'](function(error) {
        deferred.reject(new Error('Could not initiate new Project instance: '+error));
      })
      .done();
  }

  return deferred.promise;
};

/**
 * Initiates an existing (on disk) MavensMate project instance
 * @return {Promise}
 */
Project.prototype._initExisting = function() {
  var deferred = Q.defer();
  var self = this;

  if (!self._isValid()) {
    return deferred.reject(new Error('This does not seem to be a valid MavensMate project directory.'));
  }

  if (self.path !== undefined) {
    self.workspace = path.dirname(self.path);
    self.projectName = path.basename(self.path);
  } else if (self.workspace !== undefined && self.projectName !== undefined) {
    self.path = path.join(self.workspace, self.projectName);
  } else {
    self.path = process.cwd();
    self.workspace = path.dirname(self.path);
    self.projectName = path.basename(self.path); 
  }

  // if (self.path === undefined) {
  //   self.path = process.cwd();
  // }

  // self.workspace = path.dirname(self.path);
  // self.projectName = path.basename(self.path);

  // TODO: q.all or reduce
  // first order of business is to ensure we have a valid sfdc-client

  self._getSettings()
    .then(function() {
      return self._getCachedSession(); 
    })
    .then(function(cachedSession) {
      cachedSession.username = self.settings.username;
      cachedSession.password = self.settings.password;
      cachedSession.orgType = self.settings.environment;
      cachedSession.project = self;
      self.sfdcClient = new SalesforceClient(cachedSession); 
      self.sfdcClient.on('sfdcclient-cache-refresh', function() {
        self._writeSession()
          .then(self._getCachedSession())
          ['catch'](function(err) {
            throw new Error('Could not update local session cache: '+err);
          })
          .done();
      });
      return self.sfdcClient.initialize();
    })
    .then(function() {
      return self._getDescribe();
    })
    .then(function() {
      return self._getLocalStore();
    })
    .then(function() {
      return self._getClientProjectSettings();
    })
    .then(function() {
      return self._getOrgMetadata();
    })
    .then(function() {
      deferred.resolve();
    })
    ['catch'](function(error) {
      deferred.reject(error);
    })
    .done();

  return deferred.promise;
};

/**
 * Initiates an new (not yet on disk) MavensMate project instance
 * @return {Promise}
 */
Project.prototype._initNew = function() {
  var deferred = Q.defer();
  var self = this;

  if (this.workspace === undefined || this.workspace === '' || this.workspace === null) {
    var workspace;
    var workspaceSetting = config.get('mm_workspace');
    logger.debug('Workspace not specified, retrieving base workspace: ');
    logger.debug(workspaceSetting);
    if (_.isArray(workspaceSetting)) {
      workspace = workspaceSetting[0];
    } else if (_.isString(workspaceSetting)) {
      workspace = workspaceSetting;
    }
    if (!fs.existsSync(workspace)) {
      fs.mkdirSync(workspace);
    }
    this.workspace = workspace;
  } else if (!fs.existsSync(this.workspace)) {
    fs.mkdirSync(this.workspace);
  }

  this.path = path.join(self.workspace, self.projectName);
  if (fs.existsSync(self.path)) {
    deferred.reject(new Error('Directory already exists!'));
  } else {
    this.id = uuid.v1();
    deferred.resolve(this.id);
  }

  return deferred.promise;
};

Project.prototype.getName = function() {
  return this.projectName;
};

Project.prototype.getWorkspace = function() {
  return this.workspace;
};

Project.prototype._isValid = function() {
  if (this.path !== undefined) {
    return fs.existsSync(path.join(this.path, 'config', '.settings'));
  } else if (this.workspace !== undefined && this.projectName !== undefined) {
    return fs.existsSync(path.join(this.workspace, this.projectName, 'config', '.settings'));
  } else {
    return fs.existsSync(path.join(process.cwd(),'config', '.settings'));
  }
};

/**
 * Performs a Salesforce.com retrieve based on the tpye of project being requested,
 * create necessary /config, places on the disk in the correct workspace 
 * @return {Promise}
 */
Project.prototype.retrieveAndWriteToDisk = function() {
  var deferred = Q.defer();
  var self = this;

  var fileProperties;
  if (fs.existsSync(self.path)) {
    deferred.reject(new Error('Project with this name already exists in the specified workspace.'));
  } else {
    if (self.package === undefined || self.package === {}) {
      self.package = [
        'ApexClass', 'ApexComponent', 'ApexPage', 'ApexTrigger', 'StaticResource'
      ];
    }
    self.sfdcClient.describe()
      .then(function(describe) {
        logger.debug('got describe info:');
        logger.debug(describe);
        self.describe = describe;
        return self.sfdcClient.retrieveUnpackaged(self.package);
      })
      .then(function(retrieveResult) {
        var retrieveResultStream = retrieveResult.zipStream;
        fileProperties = retrieveResult.fileProperties;
        self.path = path.join(self.workspace, self.projectName);
        fs.mkdirSync(self.path);
        fs.mkdirSync(path.join(self.path, 'config'));
        return util.writeStream(retrieveResultStream, self.path);
      })
      .then(function() {
        if (fs.existsSync(path.join(self.path, 'unpackaged'))) {
          fs.renameSync(path.join(self.path, 'unpackaged'), path.join(self.path, 'src'));
        }
        // TODO: ensure packages write properly
        return self._initConfig();        
      })
      .then(function() {
        logger.debug('initing local store ... ');
        logger.debug(fileProperties);

        return self._initLocalStore(fileProperties);
      })
      .then(function() {
        deferred.resolve();
      })
      ['catch'](function(error) {
        if (fs.existsSync(self.path)) {
          fs.removeSync(self.path);
        }
        deferred.reject(error);
      })
      .done();
  } 
  
  return deferred.promise;
};

Project.prototype._initConfig = function() {
  var deferred = Q.defer();
  var self = this;

  var promises = [
    self._writeSettings(),
    self._writeSession(),
    self._writeDebug(),
    self._writeDescribe(),
    self._storePassword()
  ];

  Q.all(promises)
    .then(function() {
      deferred.resolve();
    })
    ['catch'](function(error) {
      deferred.reject(error);
    })
    .done();

  return deferred.promise; 
};

/**
 * Reverts a project to server state based on package.xml
 * @return {Promise}
 */
Project.prototype.clean = function() {
  // TODO: implement stash!

  var deferred = Q.defer();
  var self = this;

  self._parsePackageXml()
    .then(function(pkg) {
      logger.debug('package is: ', pkg);
      return self.sfdcClient.retrieveUnpackaged(pkg);
    })
    .then(function(retrieveResult) {
      var retrieveResultStream = retrieveResult.zipStream;
      var fileProperties = retrieveResult.fileProperties;
      // todo: update local store
      return util.writeStream(retrieveResultStream, self.path);
    })
    .then(function() {
      fs.removeSync(path.join(self.path, 'src'));
      if (fs.existsSync(path.join(self.path, 'unpackaged'))) {
        fs.renameSync(path.join(self.path, 'unpackaged'), path.join(self.path, 'src'));
      }
      // TODO: handle packages!
      deferred.resolve();
    })
    ['catch'](function(error) {
      deferred.reject(error);
    })
    .done(); 

  return deferred.promise;
};

/**
 * Parses package.xml to JS object
 * @return {Promise}
 */
Project.prototype._parsePackageXml = function() {
  var deferred = Q.defer();
  var self = this;
  var pkg = {};

  fs.readFile(path.join(this.path, 'src', 'package.xml'), function(err, data) {
    if (err) {
      deferred.reject(err);
    } else {
      var sax = require('sax'),
      parser = sax.parser(true);
      var isValidPackage = true;
      parser.onerror = function (e) {
        logger.debug('Parse error: package.xml --> '+e);
        isValidPackage = false;
        parser.resume();
      };
      parser.onend = function () {
        if (!isValidPackage) {
          deferred.reject(new Error('Could not parse package.xml'));
        } else {
          var doc = new xmldoc.XmlDocument(data);
          _.each(doc.children, function(type) {
            var metadataType;
            var val = [];

            if (type.name !== 'types') {
              return;
            }
            _.each(type.children, function(node) {
              if (node.name === 'name' && node.val !== undefined) {
                metadataType = node.val;
                return false;
              }
            });
            _.each(type.children, function(node) {
              if (node.name === 'members') {
                if (node.val === '*') {
                  val = '*';
                  return false;
                } else {
                  val.push(node.val);
                }
              }
            });
            pkg[metadataType] = val;        
          });
          logger.debug('parsed package.xml to -->'+JSON.stringify(pkg));
          deferred.resolve(pkg);
        }
      };
      parser.write(data.toString().trim()).close();
    }
  }); 

  return deferred.promise;
};

/**
 * Compiles projects based on package.xml
 * @return {Promise}
 */
Project.prototype.compile = function() {
  var deferred = Q.defer();
  var self = this;

  // writes temp directory, puts zip file inside
  tmp.dir({ prefix: 'mm_' }, function _tempDirCreated(err, newPath) {
    if (err) { 
      deferred.reject(err);
    } else {
      fs.copy(path.join(self.path, 'src'), path.join(newPath, 'unpackaged'), function(err){
        
        if (err) {
          return deferred.reject(err);
        }

        util.zipDirectory(path.join(newPath, 'unpackaged'), newPath)
          .then(function() {
            process.chdir(self.path);
            var zipStream = fs.createReadStream(path.join(newPath, 'unpackaged.zip'));
            return self.sfdcClient.deploy(zipStream, { rollbackOnError : true });
          })
          .then(function(result) {
            deferred.resolve(result);
          })
          ['catch'](function(error) {
            deferred.reject(error);
          })
          .done();   
      });
    }
  });
  return deferred.promise;
};

/**
 * Compiles metadata, will use metadata API or tooling API based on the metadata payload requested
 * @param  {Array} type Metadata - metadata to be compiled (must already exist in salesforce)
 * @return {Promise}
 */
Project.prototype.compileMetadata = function(metadata) {
  var deferred = Q.defer();
  var self = this;

  if (_.isArray(metadata) && _.isString(metadata[0])) {
    metadata = self.getMetadata(metadata);
  }

  // ensures all files are actually part of this project
  _.each(metadata, function(m) {
    if (m.getPath().indexOf(self.path) === -1) {
      throw new Error('Referenced file is not a part of this project: '+m.getPath());
    }
  });

  logger.debug('compiling:');
  logger.debug(metadata);

  var shouldCompileWithToolingApi = config.get('mm_compile_with_tooling_api');
  var canCompileWithToolingApi = true;

  if (shouldCompileWithToolingApi) {
    _.each(metadata, function(m) {
      if (!m.isToolingType()) {
        canCompileWithToolingApi = false;
        return false;
      }
    });
  }

  var compilerMethod = shouldCompileWithToolingApi && canCompileWithToolingApi ? 'compileWithToolingApi' : 'compileWithMetadataApi';

  self.sfdcClient[compilerMethod](metadata)
    .then(function(result) {
      deferred.resolve(result);
    })
    ['catch'](function(error) {
      deferred.reject(error);
    })
    .done();

  return deferred.promise;
};

/**
 * Edits project based on provided payload (should be a JSON package)
 * @param  {Object} payload
 * @return {Promise}
 */
Project.prototype.edit = function(pkg) {
  // TODO: implement stash!
  var deferred = Q.defer();
  var self = this;

  logger.debug('requested package is: ', pkg);
  self.sfdcClient.retrieveUnpackaged(pkg)
    .then(function(retrieveResult) {
      var retrieveResultStream = retrieveResult.zipStream;
      // var fileProperties = retrieveResult.fileProperties; TODO: update local store
      return util.writeStream(retrieveResultStream, self.path);
    })
    .then(function() {
      fs.removeSync(path.join(self.path, 'src'));
      if (fs.existsSync(path.join(self.path, 'unpackaged'))) {
        fs.renameSync(path.join(self.path, 'unpackaged'), path.join(self.path, 'src'));
      }
      // TODO: handle packages!
      deferred.resolve();
    })
    ['catch'](function(error) {
      deferred.reject(error);
    })
    .done(); 

  return deferred.promise;
};

/**
 * Refreshes local copies of Metadata from the server
 * @param  {Array} metadata
 * @return {Promise} 
 */
Project.prototype.refreshFromServer = function(metadata) {
  // TODO: implement stash

  var deferred = Q.defer();
  var self = this;

  if (_.isArray(metadata) && _.isString(metadata[0])) {
    metadata = self.getMetadata(metadata);
  }

  var metadataPayload = Metadata.objectify(metadata);
  logger.debug(metadataPayload);

  // TODO: refactor, as this pattern is used several places
  var unpackagedPath = path.join(self.workspace, self.projectName, 'unpackaged');
  if (fs.existsSync(unpackagedPath)) {
    fs.removeSync(unpackagedPath);
  }

  self.sfdcClient.retrieveUnpackaged(metadataPayload)
    .then(function(retrieveResult) {
      var retrieveResultStream = retrieveResult.zipStream;
      var fileProperties = retrieveResult.fileProperties;
      return util.writeStream(retrieveResultStream, self.path);
    })
    .then(function() {
      // TODO: handle packaged
      var finder = find(path.join(self.path, 'unpackaged'));
      finder.on('file', function (file) { 
        var fileBasename = path.basename(file);
        if (fileBasename !== 'package.xml') {
          // file => /foo/bar/myproject/unpackaged/classes/myclass.cls

          var directory = path.dirname(file); //=> /foo/bar/myproject/unpackaged/classes
          var destinationDirectory = directory.replace(path.join(self.workspace, self.projectName, 'unpackaged'), path.join(self.workspace, self.projectName, 'src')); //=> /foo/bar/myproject/src/classes

          // make directory if it doesnt exist (parent dirs included)
          if (!fs.existsSync(destinationDirectory)) {
            fs.mkdirpSync(destinationDirectory); 
          }

          // remove project metadata, replace with recently retrieved
          fs.removeSync(path.join(destinationDirectory, fileBasename));
          fs.copySync(file, path.join(destinationDirectory, fileBasename));
        }
      });
      finder.on('end', function () {
        // remove retrieved
        // TODO: package support
        var unpackagedPath = path.join(self.workspace, self.projectName, 'unpackaged');
        if (fs.existsSync(unpackagedPath)) {
          fs.removeSync(unpackagedPath);
        }
        deferred.resolve();
      });
      finder.on('error', function (err) {
        deferred.reject(new Error('Could not process retrieved metadata: '+err.message));
      });
    });

  return deferred.promise;
}; 

Project.prototype.deleteFromServer = function(metadata) {
  // TODO: implement stash
  var deferred = Q.defer();
  var self = this;
  logger.debug('deleting metadata from server: '+JSON.stringify(metadata));

  if (_.isArray(metadata) && _.isString(metadata[0])) {
    metadata = self.getMetadata(metadata);
  }

  var deploy = new Deploy({ project: self });
  deploy.stageDelete(metadata)
    .then(function(zipStream) {
      process.chdir(self.path);
      return deploy.executeStream(zipStream);
    })
    .then(function(result) {
      logger.debug('Deletion result: '+ JSON.stringify(result));
      deferred.resolve(result);
    })
    ['catch'](function(error) {
      deferred.reject(error);
    })
    .done(); 
  return deferred.promise;
};

/**
 * Stashes project contents in a tmp directory in case operation goes wrong, so we can revert
 * @return {Promise} - resolves with {String} - location of stash
 */
Project.prototype._stash = function() {
  var deferred = Q.defer();
  var self = this;

  tmp.dir({ prefix: 'mm_' }, function _tempDirCreated(err, newPath) {
    if (err) { 
      deferred.reject(new Error('Could not stash project: '+err));
    } else {
      self._stashPath = newPath;
      var srcPath = path.join(self.path, 'src');
      if (fs.existsSync(srcPath)) {
        fs.copySync(srcPath, newPath);
      }
      deferred.resolve();
    }
  });
  return deferred.promise;
};

/**
 * Removes stashed project contents
 * @return {Nothing}
 */
Project.prototype._removeStash = function() {
  if (fs.existsSync(this._stashPath)) {
    fs.removeSync(this._stashPath);
  }
};

// TODO: refers to the (optional) settings file in the project root
Project.prototype._getClientProjectSettings = function() {
  var deferred = Q.defer();
  var self = this;
  if (fs.existsSync(path.join(this.path, this.projectName+'.json'))) {
    config.file('project', path.join(this.path, this.projectName+'.json'));
    deferred.resolve('Project settings loaded.');
  } else {
    deferred.resolve('No user project settings.');
  }
  return deferred.promise;
};

Project.prototype._getCachedSession = function() {
  var deferred = Q.defer();
  var self = this;
  if (fs.existsSync()) {
    fs.readJson(path.join(this.path, 'config', '.session'), function(err, cachedSession) {
      if (err) {
        deferred.reject(err);
      } else {
        self.cachedSession = cachedSession;
        deferred.resolve(cachedSession);
      }
    });
  } else {
    deferred.resolve({});
  }
  return deferred.promise;
};

Project.prototype.getSubscription = function() {
  return this.settings.subscription;
};

/**
 * Populates project's config/.org_metadata with server metadata based on the projects subscription
 * @return {Promise}
 */
Project.prototype.indexMetadata = function() {
  var deferred = Q.defer();
  var self = this;
  // todo: stash existing
  var indexService = new IndexService({ project: this });
  indexService.indexServerProperties(self.getSubscription())
    .then(function(res) {
      // console.log('org metadata: ');
      // console.log(res);
      fs.outputFile(path.join(self.path, 'config', '.org_metadata'), JSON.stringify(res, null, 4), function(err) {
        if (err) {
          deferred.reject(err);  
        } else {
          deferred.resolve();
        }
      });
    })
    ['catch'](function(err) {
      deferred.reject('Could not index org metadata: '+err.message);
    })
    .done();

  return deferred.promise; 
};

Project.prototype._getOrgMetadata = function() {
  var deferred = Q.defer();
  var self = this;
  if (fs.existsSync(path.join(this.path, 'config', '.org_metadata'))) {
    try {
      fs.readJson(path.join(this.path, 'config', '.org_metadata'), function(err, orgMetadata) {
        if (err) {
          deferred.reject(err);
        } else {
          self.orgMetadata = orgMetadata;
          deferred.resolve(orgMetadata);
        }
      });
    } catch(e) {
      deferred.resolve([]);
    }
  } else {
    deferred.resolve([]);
  }
  return deferred.promise;
};

Project.prototype.hasIndexedMetadata = function() {
  return _.isArray(this.orgMetadata);
};

// retrieves settings from config/.settings
Project.prototype._getSettings = function() {
  var deferred = Q.defer();
  var self = this;
  fs.readJson(path.join(this.path, 'config', '.settings'), function(err, settings) {
    if (err) {
      deferred.reject(err);
    } else {
      self.settings = settings;
      self._getPassword()
        .then(function(pw) {
          self.settings.password = pw;
          deferred.resolve(self.settings);
        })
        ['catch'](function(err) {
          deferred.reject(new Error('Could not get project settings: '+err));
        })
        .done();
    }
  });
  return deferred.promise;
};

// retrieves local_store from config/.local_store
Project.prototype._getLocalStore = function() {
  var deferred = Q.defer();
  var self = this;
  fs.readJson(path.join(this.path, 'config', '.local_store'), function(err, localStore) {
    if (err) {
      deferred.reject(err);
    } else {
      self.localStore = localStore;
      deferred.resolve(localStore);
    }
  });
  return deferred.promise;
};

// retrieves describe from config/.describe
Project.prototype._getDescribe = function() {
  var deferred = Q.defer();
  var self = this;
  fs.readJson(path.join(this.path, 'config', '.describe'), function(err, describe) {
    if (err) {
      deferred.reject(err);
    } else {
      self.describe = describe;
      deferred.resolve(describe);
    }
  });
  return deferred.promise;
};

// write cached session
Project.prototype._writeSession = function() {
  var deferred = Q.defer();
  var self = this;
  var filePath = path.join(self.path, 'config', '.session');
  
  // console.log(self.sfdcClient);

  var session = {
    accessToken: self.sfdcClient.getAccessToken(),
    instanceUrl: self.sfdcClient.conn.instanceUrl
  };

  fs.outputFile(filePath, JSON.stringify(session, null, 4), function(err) {
    if (err) {
      deferred.reject(err);  
    } else {
      deferred.resolve();
    }
  });
  return deferred.promise;
};

// writes config/.settings
Project.prototype._writeDescribe = function() {
  var deferred = Q.defer();
  var file = path.join(this.path, 'config', '.describe');
  
  this.sfdcClient.describe()
    .then(function(res) {
      fs.outputFile(file, JSON.stringify(res, null, 4), function(err) {
        if (err) {
          return deferred.reject(err);  
        } else {
          deferred.resolve();
        }
      });
    })
    ['catch'](function(error) {
      deferred.reject(error);
    })
    .done(); 

  return deferred.promise;
};

// writes config/.settings
Project.prototype._writeSettings = function() {
  var deferred = Q.defer();
  var settings = {
    projectName: this.projectName,
    username: this.sfdcClient.getUsername(),
    id: this.id,
    namespace: this.sfdcClient.getNamespace(),
    environment: this.sfdcClient.getOrgType(),
    workspace: this.workspace,
    subscription: this.subscription || config.get('mm_default_subscription')
  };
  var filePath = path.join(this.path, 'config', '.settings');
  fs.outputFile(filePath, JSON.stringify(settings, null, 4), function(err) {
    if (err) {
      deferred.reject(err);  
    } else {
      deferred.resolve();
    }
  });
  return deferred.promise;
};

Project.prototype._initLocalStore = function(fileProperties) {
  var deferred = Q.defer();
  var self = this;
  self.metadataService = new MetadataService({ sfdcClient: self.sfdcClient });

  Q.when(fileProperties, function (properties) {
    try {
      logger.debug('properties -->');
      logger.debug(properties);
      var store = {};
      _.each(properties, function(fp) {
        logger.debug(fp);
        var metadataType = self.metadataService.getTypeByPath(fp.fileName);
        logger.debug(metadataType);
        if (metadataType !== undefined && fp.fullName.indexOf('package.xml') === -1) {
          var key = fp.fullName+'.'+metadataType.suffix;
          var value = fp;
          value.mmState = 'clean';
          store[key] = value;
        } else {
          if (fp.fullName.indexOf('package.xml') === -1) {
            logger.debug('Could not determine metadata type for: '+JSON.stringify(fp));
          }
        }
      });
      var filePath = path.join(self.path, 'config', '.local_store');
      fs.outputFile(filePath, JSON.stringify(store, null, 4), function(err) {
        if (err) {
          deferred.reject(new Error('Could not write local store: '+err.message));  
        } else {
          deferred.resolve();
        }
      });
    } catch(e) {
      deferred.reject(new Error('Could not initiate local store: '+e.message));  
    }
  });

  return deferred.promise;
};

Project.prototype.deleteLocalMetadata = function(metadata) {
  _.each(metadata, function(m) {
    if (fs.existsSync(m.getPath())) {
      fs.removeSync(m.getPath());
    }
    if (m.hasMetaFile()) {
      if (fs.existsSync(m.getPath()+'-meta.xml')) {
        fs.removeSync(m.getPath()+'-meta.xml');
      }  
    }
  });
};

// writes config/.debug
Project.prototype._writeDebug = function() {
	var deferred = Q.defer();
  var self = this;
  var file = path.join(this.path, 'config', '.debug');
  var fileBody = swig.renderFile('debug.json', {
    userIds: [self.sfdcClient.conn.userInfo.user_id]
  });

  fs.outputFile(file, fileBody, function(err) {
    if (err) {
      deferred.reject(err);  
    } else {
      deferred.resolve();
    }
  });
  return deferred.promise;
};

Project.prototype._storePassword = function() {
  var deferred = Q.defer();
  var result = util.storePassword(this.id, this.password);
  if (result) {
    deferred.resolve();
  } else {
    deferred.reject(new Error('Could not store password securely'));
  }
  return deferred.promise;
};

Project.prototype._getPassword = function() {
  var deferred = Q.defer();
  try {
    var result = util.getPassword(this.settings.id);
    if (result) {
      deferred.resolve(result);
    } else {
      deferred.reject(new Error('Could not retrieve password securely'));
    }
  } catch(e) {
    deferred.reject(new Error('Could not retrieve password securely: '+e.message));
  }
  return deferred.promise;
};

/**
 * Takes an array of file paths, generates Metadata instances for each (was Metadata.classify)
 * @param  {Array} files
 * @return {Array of Metadata}
 */
Project.prototype.getMetadata = function(files) {
  // TODO: handle directories, too!
  // TODO: handle folder-based metadata, like documents, templates
  // TODO: handle deeply-nested types like CustomObject/CustomField
  var metadata = [];
  var self = this;
  _.each(files, function(f) {
    metadata.push(new Metadata({ project: self, path: f }));
  });
  return metadata;
};

module.exports = Project;