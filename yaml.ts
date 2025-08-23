import jsYaml from 'js-yaml';
import yamlImport from 'yaml';

const yaml = {
  parse: (string: string) => {
    return jsYaml.load(string);
  },
  stringify: (
    object: any,
    options: {
      lineWidth?: number;
    } = { lineWidth: 0 },
  ) => {
    return yamlImport.stringify(object, options);
  },
};

export default yaml;
