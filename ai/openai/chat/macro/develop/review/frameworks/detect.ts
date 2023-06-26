import { readdirSync } from "fs-extra";
import {
  Framework,
  DetectedFrameworks
} from "../types";
import {
  uniq
} from 'lodash'


/**
 * Analyzes the package.json file and returns performs feature detection.
 * @param path 
 */
export const analyzePackageJson = (path: string): string[] => {
  const features: string[] = [];
  const packageData = require(path);
  const dependencies = packageData.dependencies;

  if (dependencies && dependencies.length > 0) {
    for (const dep in dependencies) {
      switch (dep) {
        case 'react':
          features.push('react');
          break;
        case 'react-native':
          features.push('react-native');
          break;
        case 'react-router':
          features.push('react-router');
          break;
        case 'vue':
          features.push('vue');
          break;
        case 'angular':
          features.push('angular');
          break;
        case 'typescript':
        case 'ts-node':
        case 'ts-jest':
          features.push('typescript');
          break;
        case 'babel':
        case '@babel/core':
          features.push('babel');
          break;
        case 'jest':
          features.push('jest');
          break;
        case 'mocha':
          features.push('mocha');
          break;
        case 'eslint':
          features.push('eslint');
          break;
        case 'tslint':
          features.push('tslint');
          break;
        case 'webpack':
          features.push('webpack');
          break;
        case 'gulp':
          features.push('gulp');
          break;
        case 'dotenv':
          features.push('dotenv');
          break;
        case 'mongoose':
          features.push('mongoose');
          break;
        case 'nvm':
          features.push('nvm');
          break;
      }
    }
  }

  return uniq(features);
}


/**
 * A function that inspects the project root and files and determines the project type.
 * @param path 
 * @returns 
 */
export const getFramework = (path: string): Framework[] => {
  const rootFiles = readdirSync(path, {
    withFileTypes: true,
    encoding: 'utf-8'
  });
  let features: string[] = [];

  const detected: DetectedFrameworks = {}

  for (const file of rootFiles) {
    switch (file.name) {
      case 'package.json':
        features.push('node');
        features.push(...analyzePackageJson(file.name));
        detected?.node === null ? detected.node = 1 : detected.node += 1;
        break;
      case 'tsconfig.json':
        features.push('typescript');
        detected?.typescript === null ? detected.typescript = 1 : detected.typescript += 1;
        break;
      case 'webpack.config.js':
        features.push('webpack');
        detected?.web === null ? detected.web = 1 : detected.web += 1;

        break;
      case 'jest.config.js':
        features.push('jest');
        detected?.node === null ? detected.node = 1 : detected.node += 1;
        break;
      case 'babel.config.js':
        features.push('babel');
        detected.node === null ? detected.node = 1 : detected.node += 1;
        break;
      case 'tslint.json':
        features.push('tslint');
        detected?.typescript === null ? detected.typescript = 1 : detected.typescript += 1;
        break;
      case 'eslint.json':
        features.push('eslint');
        detected?.node === null ? detected.node = 1 : detected.node += 1;
        break;
      case 'pom.xml':
        features.push('maven');
        detected?.java === null ? detected.java = 1 : detected.java += 1;
        break;
      case 'build.gradle':
        features.push('gradle');
        detected?.java === null ? detected.java = 1 : detected.java += 1;
        break;
      case 'build.xml':
        features.push('ant');
        detected?.java === null ? detected.java = 1 : detected.java += 1;
        break;
      case 'gulpfile.js':
        features.push('gulp');
        detected?.node === null ? detected.node = 1 : detected.node += 1;
        break;
      case 'angular.json':
        features.push('angular');
        detected?.web === null ? detected.web = 1 : detected.web += 1;
        break;
      case 'vue.config.js':
        features.push('vue');
        detected?.web === null ? detected.web = 1 : detected.web += 1;
        break;
      case '.nvmrc':
        features.push('nvm');
        detected.node === null ? detected.node = 1 : detected.node += 1;
        break;
      case '.env':
        features.push('dotenv');
        detected.node === null ? detected.node = 1 : detected.node += 1;
        break;
      case 'Dockerfile':
        features.push('docker');
        break;
      case '.gitignore':
      case '.git':
        features.push('git');

        break;
      case '.mocharc.js':
      case '.mocharc.json':
        features.push('mocha');
        break;
    }

    features = uniq(features);
    const frameworks: { framework: Framework, score: number }[] = [];
    Object.keys(detected).forEach(key => {
      if (detected[key] > 0) frameworks.push({ framework: key as Framework, score: detected[key] });
    });
    frameworks.sort((a, b) => b.score - a.score);
    return frameworks.map(f => f.framework);
  }
}