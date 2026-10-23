/* eslint-disable */
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const devCerts = require('office-addin-dev-certs');

module.exports = async (env, argv) => {
  const dev = argv.mode === 'development';

  const httpsOptions = dev ? (await devCerts.getHttpsServerOptions()) : undefined;

  return {
    mode: argv.mode || 'development',
    devtool: dev ? 'source-map' : false,
    entry: {
      taskpane: './src/ui/taskpane.ts',
      commands: './src/commands/commands.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].[contenthash].js',
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: 'ts-loader',
            // tsconfig keeps noEmit:true for `tsc --noEmit` typechecks; the
            // bundler needs emit on.
            options: { compilerOptions: { noEmit: false } },
          },
          exclude: [/node_modules/, /__tests__/],
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        filename: 'taskpane.html',
        template: './src/ui/taskpane.html',
        chunks: ['taskpane'],
      }),
      new HtmlWebpackPlugin({
        filename: 'commands.html',
        template: './src/commands/commands.html',
        chunks: ['commands'],
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: 'assets', to: 'assets' },
          { from: 'manifest.xml', to: 'manifest.xml' },
        ],
      }),
    ],
    devServer: {
      server: httpsOptions ? { type: 'https', options: httpsOptions } : 'http',
      port: 3000,
      headers: { 'Access-Control-Allow-Origin': '*' },
      static: { directory: path.resolve(__dirname, 'dist') },
      hot: true,
    },
  };
};
