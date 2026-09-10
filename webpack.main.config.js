const path = require('path');

module.exports = {
  entry: './main/background.ts',
  output: {
    path: path.resolve(__dirname, 'webpack/main/'),
  },
  target: 'electron-main',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /(node_modules|\.webpack)/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
          },
        },
      },
    ],
  },
  resolve: {
    alias: {
      main: path.resolve(__dirname, './main'),
    },
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
};
