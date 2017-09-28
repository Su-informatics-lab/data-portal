const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const RelayCompilerWebpackPlugin = require('relay-compiler-webpack-plugin');
const nodeExternals = require('webpack-node-externals');
const path = require('path');
const basename = process.env.BASENAME || '/';
// prefix for static file paths
const path_prefix = basename.endsWith('/') ? basename.slice(0, basename.length-1) : basename
const app = process.env.APP || 'dev';
const title = {
  dev: 'Generic Data Commons',
  bpa: 'BPA Data Commons',
  edc: 'Environmental Data Commons',
  acct: 'ACCOuNT Data Commons',
  gdc: 'Jamboree Data Access',
  bhc: 'Brain Commons',
}[app];

const plugins = [
  new webpack.EnvironmentPlugin(['NODE_ENV']),
  new webpack.EnvironmentPlugin(['MOCK_STORE']),
  new webpack.EnvironmentPlugin(['APP']),
  new webpack.EnvironmentPlugin(['BASENAME']),
  new webpack.DefinePlugin({ // <-- key to reducing React's size
    'process.env': {
      'NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'dev')
    }
  }),
  new webpack.optimize.DedupePlugin(), //dedupe similar code
  new webpack.optimize.AggressiveMergingPlugin(), //Merge chunks
  /*... doesn't work? ...
  new RelayCompilerWebpackPlugin({
    schema: path.resolve(__dirname, './data/schema.json'), // or schema.graphql
    src: path.resolve(__dirname, './src'),
  }), */
  new HtmlWebpackPlugin({
    title: title,
    basename: path_prefix,
    template: 'src/index.ejs',
    hash: true
  }),
];

if ( process.env.NODE_ENV !== 'dev' ) {
  // This slows things down a lot, so avoid when running local dev environment
  plugins.push( new webpack.optimize.UglifyJsPlugin() ); //minify everything
}

module.exports = {
  entry: ['babel-polyfill', './src/index.js'],
  exclude: '/node_modules/',

  output: {
    path: __dirname,
    filename: 'bundle.js',
    publicPath: basename
  },
  devServer: {
    historyApiFallback: {
      index: 'dev.html',
    },
    disableHostCheck: true,
  },
  module: {
    target: 'node',
    externals: [nodeExternals()],
    loaders: [
      {
        test: /\.jsx?$/,
        exclude: /(node_modules|bower_components)/,
        loaders: [
          'babel',
        ],
      },
      {
        test: /\.json$/,
        loader: 'json'
      },
      {
        test: /\.less$/,
        loaders: [
          'style',
          'css',
          'less'
        ]
      },
      {
        test: /\.css$/,
        loader: "style!css"
      },
      {
        test: /\.svg$/,
        loader: 'file'
      },
      {
        test: /\.(png|jpg)$/,
        loaders: [
          'url'
        ],
        query: {
          limit: 8192
        }
      },
      { test: /\.flow$/, loader: 'ignore-loader' }
    ]
  },
  resolve: {
    alias: {
      graphql:  path.resolve('./node_modules/graphql'),
      react:    path.resolve('./node_modules/react')                // Same issue.
    },
    extensions: [ '', '.js', '.jsx', '.json' ]
  },
  plugins,
  externals:[{
    xmlhttprequest: '{XMLHttpRequest:XMLHttpRequest}'
  }]
};
