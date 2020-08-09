const fs = require('fs');

const NodeFetch = require('node-fetch');
const FormData = require('form-data');
const QueryString = require( 'querystring' );

const FetchCookie = require('fetch-cookie');
const ToughCookie = require('tough-cookie');
const FileCookieStore = require('tough-cookie-file-store').FileCookieStore;

const CsvParser = require('csv-parser');


const ONLINE_URL = 'https://online.kasikornbankgroup.com/K-Online/';
const EBANK_URL = 'https://ebank.kasikornbankgroup.com/retail/';


const LOGIN_TOK_PATTERN = /name="txtParam" value="([a-fA-F0-9]*)"/;
const LOGOUT_TOK_PATTERN = /txtParam=([a-fA-F0-9]*)/;

const ACC_ID_PATTERN = /<option value="(?<id>[0-9]+)">(?<number>[0-9]{3}-[0-9]-[0-9]{5}-[0-9]) (?<name>.*?)<\/option>/g;
const BAL_PATTERN = /<td class="inner_table_center">(?<number>[0-9]{3}-[0-9]-[0-9]{5}-[0-9])<\/td>[\s\S]*?<td class="inner_table_center" colspan="2">(?<name>.*?)<\/td>[\s\S]*?<td class="inner_table_right">(?<balance>.*?)<\/td>/g;


const cleanNumber = x => x.replace( /-/g, '' );

const groupRewriter = x => Object.assign( { }, x.groups );

const extract = ( data, re ) => {
  let mat = data.match( re );
  if ( mat ) {
    if ( mat.groups ) 
      return groupRewriter( mat.groups );
    else
      return [ ... mat ].slice( 1 );
  }
};

const extractAll = ( data, re ) => {
  let mat = data.matchAll( re );
  if ( mat ) 
    return [ ... mat ].map( groupRewriter );
};


const STMT_COLS = [
  'datetime', // Date
  'type', // Transaction Type
  'withdrawal', // Withdrawal (THB)
  'deposit', // Deposit (THB)
  'balance', // Outstanding Balance (THB)
  'channel', // Service Channel
  'note', // Note
  'ignored'
];

const TODAY_STMT_COLS = [
  'datetime', // Date
  'channel', // Service Channel
  'type', // Transaction Type
  'withdrawal', // Withdrawal (THB)
  'deposit', // Deposit (THB)
  'ignored1',
  'ignored2' // Note
];


class KBank {
  constructor( username, password, cookiepath ) {
    this.setCredential( username, password );
    this.setCookiePath( cookiepath );
  }

  /* re-decorate fetch */
  _wrapFetch( ) {
    this._fetch = FetchCookie( 
      NodeFetch, 
      new ToughCookie.CookieJar( this._cookieStore ) 
    );
  }

  /* fetch wrapper so that all request share same cookies */
  _submit( url, getdata, data ) {
    const opts = { };
    /* 
    stop automatic redirect follower 
    so we can see http status of page we requested 
    not page that requested page redirect to.
    */
    opts.redirect = 'manual';
    if ( getdata ) 
      url += '?' + QueryString.stringify( getdata );
    if ( data ) {
      /* convert object to FormData */
      const form = new FormData( );
      for ( const key in data ) {
        const val = data[ key ];
        form.append( key, val );
      }
      opts.method = 'POST';
      opts.body = form;
    }
    return this._fetch( url, opts );
  }

  setCredential( username, password ) {
    const failed = !( 
      username && typeof username === 'string' && 
      password && typeof password === 'string' 
    );
    if ( failed ) throw new RangeError( 'please enter username and password' );
    this.username = username;
    this.password = password;
  }

  /*
  NOTE: benefit of using file storage cookie jar is
  it can shared session between multiple instances!
  so you don't need to login each time instance is created.
  */
  setCookiePath( path ) {
    if ( path && typeof path === 'string' ) {
      if ( !fs.existsSync( path ) ) {
        /* create empty file */
        let fd = fs.openSync( path, 'w' );
        fs.closeSync( fd );
      }
      this._cookieStore = new FileCookieStore( path );
    } else {
      this._cookieStore = new ToughCookie.MemoryCookieStore( );
    }
    this._wrapFetch( );
  }

  async isLogin( ) {
    const resp = await this._submit( ONLINE_URL + 'checkSession.jsp' );
    return resp.status === 200;
  }

  async login( ) {
    /* login online bank */
    let formdata = {
      tokenId: '0',
      cmd: 'authenticate',
      userName: this.username,
      password: this.password,
      locale: 'en'
    };
    let resp = await this._submit( ONLINE_URL + 'login.do', null, formdata );
    if ( resp.status !== 302 ) return false;
    /* get cross-site login token */
    resp = await this._submit( ONLINE_URL + 'ib/redirectToIB.jsp' );
    if ( resp.status !== 200 ) return false;
    let text = await resp.text( );
    /* extract token from page */
    let [ token ] = extract( text, LOGIN_TOK_PATTERN );
    /* login E-Bank */
    formdata = { 
      txtParam: token 
    };
    resp = await this._submit( EBANK_URL + 'security/Welcome.do', null, formdata );
    return resp.status === 302;
  }

  async logout( ) {
    /* logout online bank and get cross-site logout token */
    let querydata =  { 
      cmd: 'success' 
    };
    let resp = await this._submit( ONLINE_URL + 'logout.do', querydata );
    if ( resp.status !== 200 ) return false;
    let text = await resp.text( );
    /* extract token from page */
    let [ token ] = extract( text, LOGOUT_TOK_PATTERN );
    /* logout E-Bank */
    querydata = { 
      action: 'retailuser', 
      txtParam: token 
    };
    resp = await this._submit( EBANK_URL + 'security/Logout.do', querydata );
    return resp.status === 302;
  }

  async getAccounts( ) {
    let resp = await this._submit( EBANK_URL + 'accountinfo/AccountStatementInquiry.do' );
    if ( resp.status !== 200 ) return false;
    let text = await resp.text( );
    /* cache account number mapping */
    return this._accounts = extractAll( text, ACC_ID_PATTERN );
  }

  async getBalances( ) {
    let querydata = {
      action: 'list_domain2'
    };
    let resp = await this._submit( EBANK_URL + 'cashmanagement/inquiry/AccountSummary.do', querydata );
    if ( resp.status !== 200 ) return false;
    let text = await resp.text( );
    return extractAll( text, BAL_PATTERN );
  }

  async *_parseStatement( stream, opt ) {
    const { length } = opt.headers;
    const parser = CsvParser( opt );
    stream.pipe( parser );
    for await ( let cols of parser ) {
      const headers = Object.keys( cols );
      /* skip incomplete row (missing some column, empty line) */
      if ( headers.length < length ) continue;
      /* remove placeholder column */
      for ( let header of headers )
        if ( header.startsWith( 'ignored' ) ) 
          delete cols[ header ];
      yield cols;
    }
  }

  async *getStatement( num, start, end ) {
    let formdata = {
      action: 'sa_download',
      selAccountNo: '|' + cleanNumber( num ) + '||||||',
      selDayFrom: start.getDate( ),
      selMonthFrom: start.getMonth( ) + 1,
      selYearFrom: start.getFullYear( ),
      selDayTo: end.getDate( ),
      selMonthTo: end.getMonth( ) + 1,
      selYearTo: end.getFullYear( ),
      period: '3'
    };
    let resp = await this._submit( EBANK_URL + 'accountinfo/AccountStatementInquiry.do', null, formdata );
    if ( resp.status !== 200 ) return;
    /* parse csv result */
    yield *this._parseStatement( resp.body, { skipLines: 7, headers: STMT_COLS } );
  }

  async *getTodayStatement( num ) {
    if ( !this._accounts ) 
      await this.getAccounts( );
    /* lookup account id */
    const acct = this._accounts.find( x => x.number === num );
    if ( !acct ) return;
    /* prepare result */
    let formdata = {
      acctId: acct.id,
      action: 'detail'
    };
    let resp = await this._submit( EBANK_URL + 'cashmanagement/TodayAccountStatementInquiry.do', null, formdata );
    if ( resp.status !== 200 ) return;
    /* get result */
    formdata = {
      acctId: acct.id,
      action: 'download'
    };
    resp = await this._submit( EBANK_URL + 'cashmanagement/TodayAccountStatementInquiry.do', null, formdata );
    if ( resp.status !== 200 ) return;
    /* parse csv result */
    yield *this._parseStatement( resp.body, { skipLines: 7,  headers: TODAY_STMT_COLS } );
  }
}

module.exports = KBank;
