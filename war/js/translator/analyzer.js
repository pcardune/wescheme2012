// if not defined, declare the compiler object as part of plt
window.plt   = window.plt   || {};
plt.compiler = plt.compiler || {};

/*
 TODO
 - stop using synchronous XmlHttpRequests -> probably only after the compiler is folded into the evaluator
*/

(function () {
 'use strict';
 
 // tag-application-operator/module: Stx module-name -> Stx
 // Adjust the lexical context of the func so it refers to the environment of a particular module.
 function tagApplicationOperator_Module(application, moduleName){
    // get the module's env
    var module = plt.compiler.defaultModuleResolver(moduleName),
        env = new plt.compiler.emptyEnv().extendEnv_moduleBinding(module);
    // assign it as the context of the function, and each of the arguments
    [application.func].concat(application.args).forEach(function(expr){expr.context = env;});
    return application;
 }

 // forceBooleanContext: stx, loc, bool -> stx
 // Force a boolean runtime test on the given expression.
 function forceBooleanContext(stx, loc, boolExpr){
    stx = new literal(new types.string(stx.toString())); // turn the stx object into a string literal
    var verifyCall  = new symbolExpr("verify-boolean-branch-value"),
        stxQuote    = new quotedExpr(stx),
        locQuote    = new quotedExpr(new literal(loc.toVector())),
        boolLocQuote= new quotedExpr(new literal(boolExpr.location.toVector())),
        runtimeCall = new callExpr(verifyCall, [stxQuote, locQuote, boolExpr, boolLocQuote]);
    runtimeCall.location = verifyCall.location = boolExpr.location;
    stxQuote.location=locQuote.location=boolLocQuote.location = boolExpr.location;
    tagApplicationOperator_Module(runtimeCall, 'moby/runtime/kernel/misc');
    return runtimeCall;
 }
 
 //////////////////////////////////////////////////////////////////////////////
 // DESUGARING ////////////////////////////////////////////////////////////////

 // desugarProgram : Listof Programs null/pinfo -> [Listof Programs, pinfo]
 // desugar each program, appending those that desugar to multiple programs
 function desugarProgram(programs, pinfo, isTopLevelExpr){
      var acc = [ [], (pinfo || new plt.compiler.pinfo())];
      var res = programs.reduce((function(acc, p){
            var desugaredAndPinfo = p.desugar(acc[1]);
            // if it's an expression, insert a print-values call so it shows up in the repl
            if(plt.compiler.isExpression(p) && isTopLevelExpr){
              var printValues = new symbolExpr("print-values"),
                  printCall = new callExpr(printValues, [desugaredAndPinfo[0]]);
               // set the location of the print-values call to that of the expression
              printValues.location = printCall.location = desugaredAndPinfo[0].location;
              desugaredAndPinfo[0] = printCall;
              tagApplicationOperator_Module(printCall,'moby/runtime/kernel/misc');
            }
            if(desugaredAndPinfo[0].length){
              acc[0] = acc[0].concat(desugaredAndPinfo[0]);
            } else {
              acc[0].push(desugaredAndPinfo[0]);
            }
            return [acc[0], desugaredAndPinfo[1]];
        }), acc);
      res[0].location = programs.location;
      return res;
 }
 
 // Program.prototype.desugar: pinfo -> [Program, pinfo]
 Program.prototype.desugar = function(pinfo){ return [this, pinfo]; };
 defFunc.prototype.desugar = function(pinfo){
    // check for duplicate arguments
    checkDuplicateIdentifiers([this.name].concat(this.args), this.stx[0], this.location);
    // check for non-symbol arguments
    this.args.forEach(function(arg){
       if(!(arg instanceof symbolExpr)){
        throwError(new types.Message([new types.ColoredPart(this.stx.val, this.stx.location)
                                , ": expected a variable but found "
                                , new types.ColoredPart("something else", arg.location)])
                   , sexp.location);
      }
    });
    var bodyAndPinfo = this.body.desugar(pinfo);
    this.body = bodyAndPinfo[0];
    return [this, bodyAndPinfo[1]];
 };
 defVar.prototype.desugar = function(pinfo){
    // convert (define f (lambda (x) x)) into (define (f x) x)
    if(this.expr instanceof lambdaExpr){
      var func = new defFunc(this.name, this.expr.args, this.expr.body, this.stx);
      func.location = this.location;
      return func.desugar(pinfo);
    } else {
      var exprAndPinfo = this.expr.desugar(pinfo);
      this.expr = exprAndPinfo[0];
      return [this, exprAndPinfo[1]];
    }
 };
 defVars.prototype.desugar = function(pinfo){
    var exprAndPinfo = this.expr.desugar(pinfo);
    this.expr = exprAndPinfo[0];
    return [this, exprAndPinfo[1]];
 };
 defStruct.prototype.desugar = function(pinfo){
    var that = this,
        ids = ['make-'+this.name.val, this.name.val+'?', this.name.val+'-ref', this.name.val+'-set!'],
        idSymbols = ids.map(function(id){return new symbolExpr(id);}),
        makeStructTypeFunc = new symbolExpr('make-struct-type'),
        makeStructTypeArgs = [new quotedExpr(new symbolExpr(this.name.val)),
                              new literal(false),
                              new literal(this.fields.length),
                              new literal(0)],
        makeStructTypeCall = new callExpr(makeStructTypeFunc, makeStructTypeArgs);
    // set location for all of these nodes
    [makeStructTypeCall, makeStructTypeFunc].concat(idSymbols, makeStructTypeArgs).forEach(function(p){p.location = that.location});
 
    // make the define-values stx object, but store the original stx for define-struct
    var defineValuesStx = new defVars([this.name].concat(idSymbols), makeStructTypeCall, this.stx),
        stxs = [defineValuesStx];
    defineValuesStx.location = this.location;
    // given a field, make a definition that binds struct-field to the result of
    // a make-struct-field accessor call in the runtime
    function makeAccessorDefn(f, i){
      var makeFieldFunc = new symbolExpr('make-struct-field-accessor'),
          makeFieldArgs = [new symbolExpr(that.name.val+'-ref'), new literal(i), new quotedExpr(new symbolExpr(f.val))],
          makeFieldCall = new callExpr(makeFieldFunc, makeFieldArgs),
          accessorSymbol= new symbolExpr(that.name.val+'-'+f.val),
          defineVar = new defVar(accessorSymbol, makeFieldCall);
      // set location for all of these nodes
      [defineVar, makeFieldFunc, makeFieldCall, accessorSymbol].concat(makeFieldArgs).forEach(function(p){p.location = that.location});
      stxs.push(defineVar);
    }
    this.fields.forEach(makeAccessorDefn);
    return [stxs, pinfo];
 };
 beginExpr.prototype.desugar = function(pinfo){
    var exprsAndPinfo = desugarProgram(this.exprs, pinfo);
    this.exprs = exprsAndPinfo[0];
    return [this, exprsAndPinfo[1]];
 };
 lambdaExpr.prototype.desugar = function(pinfo){
    // if this was parsed from raw syntax, check for duplicate arguments
    if(this.stx) checkDuplicateIdentifiers(this.args, this.stx, this.location);
    var bodyAndPinfo = this.body.desugar(pinfo);
    this.body = bodyAndPinfo[0];
    return [this, bodyAndPinfo[1]];
 };
 localExpr.prototype.desugar = function(pinfo){
    var defnsAndPinfo = desugarProgram(this.defs, pinfo);
    var exprAndPinfo = this.body.desugar(defnsAndPinfo[1]);
    this.defs = defnsAndPinfo[0];
    this.body = exprAndPinfo[0];
    return [this, exprAndPinfo[1]];
 };
 callExpr.prototype.desugar = function(pinfo){
    var exprsAndPinfo = desugarProgram([this.func].concat(this.args), pinfo);
    this.func = exprsAndPinfo[0][0];
    this.args = exprsAndPinfo[0].slice(1);
    return [this, exprsAndPinfo[1]];
 };
 ifExpr.prototype.desugar = function(pinfo){
    var exprsAndPinfo = desugarProgram([this.predicate,
                                        this.consequence,
                                        this.alternative],
                                       pinfo);
    // preserve location information -- esp for the predicate!
    exprsAndPinfo[0][0].location = this.predicate.location;
    exprsAndPinfo[0][1].location = this.consequence.location;
    exprsAndPinfo[0][2].location = this.alternative.location;
    this.predicate = forceBooleanContext(this.stx, this.stx.location, exprsAndPinfo[0][0]);
    this.consequence = exprsAndPinfo[0][1];
    this.alternative = exprsAndPinfo[0][2];
    return [this, exprsAndPinfo[1]];
 };

 // letrecs become locals
 letrecExpr.prototype.desugar = function(pinfo){
    function bindingToDefn(b){
      var def = new defVar(b.first, b.second);
      def.location = b.location;
      return def
    };
    var localAndPinfo = new localExpr(this.bindings.map(bindingToDefn), this.body).desugar(pinfo);
    localAndPinfo[0].location = this.location;
    return localAndPinfo;
 };
 // lets become calls
 letExpr.prototype.desugar = function(pinfo){
    // utility functions for accessing first and second
    function coupleFirst(x) { return x.first; };
    function coupleSecond(x) { return x.second; };

    var ids   = this.bindings.map(coupleFirst),
        exprs = this.bindings.map(coupleSecond),
        lambda= new lambdaExpr(ids, this.body, this.stx),
        call  = new callExpr(lambda, exprs);
    lambda.location = call.location = this.location;
    return call.desugar(pinfo);
 };
 // let*s become nested lets
 letStarExpr.prototype.desugar = function(pinfo){
    var body = this.body;
    for(var i=0; i<this.bindings.length; i++){
      body = new letExpr([this.bindings[i]], body, this.bindings[i].stx);
      body.location = this.bindings[i].location;
    }
    return body.desugar(pinfo);
 };
 // conds become nested ifs
 condExpr.prototype.desugar = function(pinfo){
    // base case is all-false
    var condExhausted = new symbolExpr("throw-cond-exhausted-error"),
        exhaustedLoc = new quotedExpr(new literal(this.location.toVector())),
        expr = tagApplicationOperator_Module(new callExpr(condExhausted, [exhaustedLoc])
                                             , "moby/runtime/kernel/misc");
    expr.location = condExhausted.location = exhaustedLoc.location = this.location;
    for(var i=this.clauses.length-1; i>-1; i--){
      // desugar else to true
      if(this.clauses[i].first instanceof symbolExpr && this.clauses[i].first.val === "else"){
        this.clauses[i].first.val = "true";
      }
      expr = new ifExpr(this.clauses[i].first, this.clauses[i].second, expr, this.stx);
      expr.location = this.location;
    }
    return expr.desugar(pinfo);
 };
 // case become nested ifs, with ormap as the predicate
 caseExpr.prototype.desugar = function(pinfo){
    var that = this,
        caseStx = new symbolExpr("if"); // TODO: The server returns "if" here, but I am almost certain it should be "case"
    caseStx.location = that.location;

    var pinfoAndValSym = pinfo.gensym('val'),      // create a symbol 'val'
        updatedPinfo1 = pinfoAndValSym[0],        // generate pinfo containing 'val'
        valStx = pinfoAndValSym[1];               // remember the symbolExpr for 'val'
    var pinfoAndXSym = updatedPinfo1.gensym('x'), // create another symbol 'x' using pinfo1
        updatedPinfo2 = pinfoAndXSym[0],          // generate pinfo containing 'x'
        xStx = pinfoAndXSym[1],                   // remember the symbolExpr for 'x'
        voidStx = new symbolExpr('void');         // make the void symbol

    // track all the syntax we've created so far...
    var stxs = [valStx, xStx, voidStx];

    // if there's an 'else', pop off the clause and use the result as the base
    var expr, clauses = this.clauses, lastClause = clauses[this.clauses.length-1];
    if((lastClause.first instanceof symbolExpr) && (lastClause.first.val === 'else')){
      expr = lastClause.second;
      clauses.pop();
    } else {
      expr = new callExpr(voidStx,[], that.stx);
      expr.location = that.location;
    }

    // This is the predicate we'll be applying using ormap: (lambda (x) (equal? x val))
    var equalStx = new symbolExpr('equal?'),
        equalTestStx = new callExpr(equalStx, [xStx, valStx], caseStx),
        predicateStx = new lambdaExpr([xStx], equalTestStx, caseStx);
    stxs = stxs.concat([equalStx, equalTestStx, predicateStx]);
 
    // the parser will treat each clause.first as a function appled to some args
    // remix it into a <list> of [func].concat[args]
    // generate (if (ormap <predicate> (quote <list>)) clause.second base)
    function processClause(base, clause){
      var ormapStx = new symbolExpr('ormap'),
          quoteStx = new quotedExpr([clause.first.func].concat(clause.first.args)),
          callStx = new callExpr(ormapStx, [predicateStx, quoteStx], that.stx),
          ifStx = new ifExpr(callStx, clause.second, base, caseStx);
      stxs = stxs.concat([ormapStx, callStx, quoteStx, ifStx]);
      return ifStx;
    }

    // build the body of the let by decomposing cases into nested ifs
    var binding = new couple(valStx, this.expr),
        body = clauses.reduceRight(processClause, expr),
        letExp = new letExpr([binding], body, caseStx);
    stxs = stxs.concat([binding, body, letExp]);
 
    // assign location to every stx element we created
    stxs.forEach(function(stx){stx.location = that.location;});
    return letExp.desugar(updatedPinfo2);
 };
 
 // ands become nested ifs
 andExpr.prototype.desugar = function(pinfo){
    var that = this, ifStx = new symbolExpr("if"),
        exprsAndPinfo = desugarProgram(this.exprs, pinfo),
        exprs = exprsAndPinfo[0],
        pinfo = exprsAndPinfo[1];
 
    // recursively walk through the exprs
    function desugarAndExprs(exprs){
      var predicate = forceBooleanContext(that.stx, that.stx.location, exprs[0]),
          // if there only two exprs in the chain, force a boolean ctx on the second expr and make it the consequence
          // otherwise, desugar the rest of the chain before adding it
          consequence = (exprs.length > 2)? desugarAndExprs(exprs.slice(1))
                                          : forceBooleanContext(that.stx, that.stx.location, exprs[1]),
          alternative = new literal(false),
          ifLink = new ifExpr(predicate, consequence, alternative, ifStx),
          stxs = [alternative, ifStx, ifLink];
 
      // assign location information to everything
      stxs.forEach(function(stx){return stx.location = that.location;});
      return ifLink;
    }
 
    var ifChain = desugarAndExprs(exprs);
    ifChain.location = that.location;
    return [ifChain, pinfo];
 };
 // ors become nested lets-with-if-bodies
 orExpr.prototype.desugar = function(pinfo){
    var that = this, orStx = new symbolExpr("or"),
        exprsAndPinfo = desugarProgram(this.exprs, pinfo),
        exprs = exprsAndPinfo[0],
        pinfo = exprsAndPinfo[1];
 
    // recursively walk through the exprs
    function desugarOrExprs(exprs, pinfo){
      var firstExpr = exprs[0], exprLoc = firstExpr.location,
          pinfoAndTempSym = pinfo.gensym('tmp'),
          firstExprSym = pinfoAndTempSym[1],
          pinfo = pinfoAndTempSym[0],
          tmpBinding = new couple(firstExprSym, forceBooleanContext(that.stx, that.stx.location, firstExpr)),
          secondExpr;
 
      // if there are only two exprs in the chain, force a boolean ctx on the second expr before adding
      // otherwise, desugar the rest of the chain before adding it
      if(exprs.length == 2){
        secondExpr = forceBooleanContext(orStx, that.stx.location, exprs[1]);
      } else  {
        var secondExprAndPinfo = desugarOrExprs(exprs.slice(1), pinfo);
        secondExpr = secondExprAndPinfo[0];
        pinfo = secondExprAndPinfo[1];
      }

      // create if and let expressions, using these new symbols and bindings
      var if_exp = new ifExpr(firstExprSym, firstExprSym, secondExpr, new symbolExpr("if")),
          let_exp = new letExpr([tmpBinding], if_exp, orStx),
          stxs = [orStx, firstExprSym, tmpBinding, if_exp, if_exp.stx, let_exp];
      // assign location information to everything
      stxs.forEach(function(stx){return stx.location = that.location;});
      return let_exp.desugar(pinfo);
    }
 
    return desugarOrExprs(exprs, pinfo);
 };

 quotedExpr.prototype.desugar = function (pinfo) {
   if (typeof this.location === 'undefined') {
     throwError( new types.Message(["ASSERTION ERROR: Every quotedExpr should have a location"])
               , loc)
   }
 
   // Sexp-lists (arrays) become lists
   // literals and symbols stay themselves
   // everything else gets desugared
   function desugarQuotedItem(pinfo, loc){
     return function (x) {
       if (  x instanceof callExpr
          || x instanceof quotedExpr
          || x instanceof unsupportedExpr
          ) {
         return x.desugar(pinfo);
       } else if (  x instanceof symbolExpr
                 || x instanceof literal
                 || x instanceof Array
                 ) {
         var res = new quotedExpr(x);
         res.location = loc;
         return [res, pinfo];
       } else {
         throwError(new types.Message(["ASSERTION ERROR: Found an unexpected item in a quotedExpr"])
                   , loc);
       }
     }
   }
 
   return desugarQuotedItem(pinfo, this.location)(this.val);
 };

 unquotedExpr.prototype.desugar = function (pinfo, depth) {
   if (typeof depth === 'undefined') {
     throwError( new types.Message(["misuse of a ', not under a quasiquoting backquote"])
               , this.location);
   } else if (depth === 1) {
     return this.val.desugar(pinfo);
   } else if (depth > 1) {
     if (this.val instanceof Array) {
       return desugarQuasiQuotedList(element, pinfo, depth-1);
     } else {
       var uSym = new quotedExpr(new symbolExpr('unquote')),
           listSym = new symbolExpr('list'),
           listArgs = [uSym, this.val.desugar(pinfo, depth-1)[0]],
           listCall = new callExpr(listSym, listArgs);
       uSym.location = this.location;
       uSym.parent = listArgs;
       listSym.location = this.location;
       listSym.parent = listCall;
       listCall.location = this.location;
       return [listCall, pinfo];
     }
   } else {
     throwError( new types.Message(["ASSERTION FAILURE: depth should have been undefined, or a natural number"])
               , this.location);
   }
 };

 unquoteSplice.prototype.desugar = function (pinfo, depth) {
   if (typeof depth === 'undefined') {
     throwError( new types.Message(["misuse of a ,@, not under a quasiquoting backquote"])
               , this.location);
   } else if (depth === 1) {
     return this.val.desugar(pinfo);
   } else if (depth > 1) {
     if (this.val instanceof Array) {
       return desugarQuasiQuotedList(element, pinfo, depth-1);
     } else {
       var usSym = new quotedExpr(new symbolExpr('unquote-splicing')),
           listSym = new symbolExpr('list'),
           listArgs = [usSym, this.val.desugar(pinfo, depth-1)[0]],
           listCall = new callExpr(listSym, listArgs);
       usSym.location = this.location;
       usSym.parent = listArgs;
       listSym.location = this.location;
       listSym.parent = listCall;
       listCall.location = this.location;
       return [listCall, pinfo];
     }
   } else {
     throwError( new types.Message(["ASSERTION FAILURE: depth should have been undefined, or a natural number"])
               , this.location);
   }
 };

 function desugarQuasiQuotedList(qqlist, pinfo, depth) {
 
    // helper function for a single QQ-list element
    function desugarQuasiQuotedListElement(element, pinfo, depth, loc) {
     if (depth === 0 && element instanceof unquoteSplice) {
       return element.desugar(pinfo, depth);
     } else {
       var argument = (element instanceof Array) ?
            desugarQuasiQuotedList(element, depth, depth)[0] :
            element.desugar(pinfo, depth)[0],
           listSym = new symbolExpr('list'),
           listCall = new callExpr(listSym, [argument]);
       listSym.parent = listCall;
       listCall.location = listSym.location = loc;
       return [listCall, pinfo];
     }
   }
 
   var loc = (typeof qqlist.location != 'undefined') ? qqlist.location :
              ((qqlist instanceof Array) && (typeof qqlist[0].location != 'undefined')) ? qqlist[0].location :
              (throwError( types.Message(["ASSERTION FAILURE: couldn't find a usable location"])
                          , new Location(0,0,0,0))),
       appendArgs = qqlist.map(function(x){ return desugarQuasiQuotedListElement(x, pinfo, depth, loc)[0]; }),
       appendSym = new symbolExpr('append');
   appendSym.location = loc
   var appendCall = new callExpr(appendSym, appendArgs);
   appendCall.location = loc;
   return [appendCall, pinfo];
 }

 // go through each item in search of unquote or unquoteSplice
 quasiquotedExpr.prototype.desugar = function(pinfo, depth){
   depth = (typeof depth === 'undefined') ? 0 : depth;
   if (depth >= 0) {
     var result;
     if(this.val instanceof Array){
       result = desugarQuasiQuotedList(this.val, pinfo, depth+1)[0];
     } else {
       result = this.val.desugar(pinfo, depth+1)[0];
     }
   } else {
     throwError( new types.Message(["ASSERTION FAILURE: depth should have been undefined, or a natural number"])
               , this.location);
   }

   if (depth == 0) {
     return [result, pinfo];
   } else {
     var qqSym = new quotedExpr(new symbolExpr('quasiquote')),
         listArgs = [qqSym, result],
         listSym = new symbolExpr('list'),
         listCall = new callExpr(listSym, listArgs);
     qqSym.parent = listArgs;
     qqSym.location = this.location;
     result.parent = listArgs;
     listSym.parent = listCall;
     listSym.location = this.location;
     listCall.location = this.location;
     return [listCall, pinfo]
   }
 };
 
 symbolExpr.prototype.desugar = function(pinfo){
    // if we're not in a clause, we'd better not see an "else"...
    if(!this.isClause && (this.val === "else")){
        var loc = (this.parent && this.parent[0] === this)? this.parent.location : this.location;
        throwError(new types.Message([new types.ColoredPart(this.val, loc)
                                      , ": not allowed "
                                      , new types.ColoredPart("here", loc)
                                      , ", because this is not a question in a clause"]),
                   loc);
    }
    // if this is a define without a parent, or if it's not the first child of the parent
    if((this.parent && this.parent[0] !== this) && (this.val === "define")){
        var msg = new types.Message([new types.ColoredPart(this.val, this.location)
                                     , ": not allowed inside an expression"]);
        msg.betterThanServer = true;
        throwError(msg, this.location);
    }
    // if this is a keyword without a parent, or if it's not the first child of the parent
    if(!this.parent &&
       (plt.compiler.keywords.indexOf(this.val) > -1) && (this.val !== "else")){
        throwError(new types.Message([new types.ColoredPart(this.val, this.location)
                                      , ": expected an open parenthesis before "
                                      , this.val
                                      , ", but found none"]),
                    this.location);
    }
    // the dot operator is not supported by WeScheme
    if(this.val === "."){
     var msg = new types.Message([this.location.source, ":",
                                   this.location.sLine.toString(), ":",
                                   this.location.sCol.toString()
                                  , ": read: '.' is not supported as a symbol in WeScheme"]);
     msg.betterThanServer = true;
     throwError(msg
                 , this.location
                 , "Error-GenericReadError");
    }
    return [this, pinfo];
 };
 unsupportedExpr.prototype.desugar = function(pinfo){
    this.location.span = this.errorSpan;
    throwError(this.errorMsg, this.location, "Error-GenericReadError");
 }
 
 //////////////////////////////////////////////////////////////////////////////
 // COLLECT DEFINITIONS ///////////////////////////////////////////////////////

 // extend the Program class to collect definitions
 // Program.collectDefnitions: pinfo -> pinfo
 Program.prototype.collectDefinitions = function(pinfo){ return pinfo; };

 // bf: symbol path number boolean string -> binding:function
 // Helper function.
 function bf(name, modulePath, arity, vararity, loc){
    return new functionBinding(name, modulePath, arity, vararity, [], false, loc);
 }
 defFunc.prototype.collectDefinitions = function(pinfo){
    this.args.forEach(function(arg){
      if(plt.compiler.keywords.indexOf(arg.val) > -1){
          throwError(new types.Message([new types.ColoredPart(arg.val, arg.location),
                                        ": this is a reserved keyword and cannot be used"+
                                        " as a variable or function name"])
                     , arg.location);
           
               }
      });
 
    var binding = bf(this.name.val, false, this.args.length, false, this.name.location);
    return pinfo.accumulateDefinedBinding(binding, this.location);
 };
 defVar.prototype.collectDefinitions = function(pinfo){
    var binding = (this.expr instanceof lambdaExpr)?
                    bf(this.name.val, false, this.expr.args.length, false, this.name.location)
                  : new constantBinding(this.name.val, false, [], this.name.location);
    return pinfo.accumulateDefinedBinding(binding, this.location);
 };
 defVars.prototype.collectDefinitions = function(pinfo){
    var that = this,
        fieldToAccessor = function(f){return that.stx[1].val+"-"+f.val;},
        fieldToMutator = function(f){return "set-"+that.stx[1].val+"-"+f.val+"!";};
    // if it's define-struct, create a struct binding
    if(that.stx[0].val === "define-struct"){
      var id      = that.stx[1].val,
          fields  = that.stx[2],
          constructorId = "make-"+id,
          predicateId   = id+"?",
          selectorIds   = fields.map(fieldToAccessor),
          mutatorIds    = fields.map(fieldToMutator),
          // build bindings out of these ids
          structureBinding = new structBinding(id, false, fields, constructorId, predicateId,
                                               selectorIds, mutatorIds, null, that.stx[1].location),
          constructorBinding = bf(constructorId, false, fields.length, false, that.location),
          predicateBinding   = bf(predicateId, false, 1, false, that.location),
          mutatorBinding     = bf(id+"-set!", false, 1, false, that.location),
          refBinding         = bf(id+"-ref", false, 1, false, that.location),
 // COMMENTED OUT ON PURPOSE:
 // these symbols are provided by separate definitions that result from desugaring, in keeping with the original compiler's behavior
 //        selectorBindings   = selectorIds.map(function(id){return bf(id, false, 1, false, that.location)}),
 // AND WOULD YOU BELIEVE IT:
 //  these symbols aren't exposed by the compiler either (maybe since set! isn't supported?)
 //        mutatorBindings    = mutatorIds.map(function(id){return bf(id, false, 2, false, that.location)}),
          // assemble all the bindings together
          bindings = [structureBinding, refBinding, constructorBinding, predicateBinding, mutatorBinding];
      return pinfo.accumulateDefinedBindings(bindings, that.location);
    } else {
      return this.names.reduce(function(pinfo, id){
        var binding = new constantBinding(id.val, false, [], id.location);
        return pinfo.accumulateDefinedBinding(binding, that.location);
      }, pinfo);
    }
 };

 // When we hit a require, we have to extend our environment to include the list of module
 // bindings provided by that module.
 // FIXME: we currently override moduleName, which SHOULD just give us the proper name
 requireExpr.prototype.collectDefinitions = function(pinfo){
    // if it's a literal, pull out the actual value. if it's a symbol use it as-is
    var moduleName = (this.spec instanceof literal)? this.spec.val.toString() : this.spec.toString(),
        resolvedModuleName = pinfo.modulePathResolver(moduleName, pinfo.currentModulePath),
        that = this,
        newPinfo;
 
    // is this a shared WeScheme program?
    function getWeSchemeModule(name){
      var m = name.match(/^wescheme\/(\w+)$/);
      return m? m[1] : false;
    }
 
    function throwModuleError(moduleName){
      var bestGuess = plt.compiler.moduleGuess(that.spec.toString());
      var msg = new types.Message(["Found require of the module "
                                   , new types.ColoredPart(that.spec.toString(), that.spec.location)
                                   , ", but this module is unknown."
                                   , ((bestGuess.name===that.spec.toString())? "": " Did you mean '"+bestGuess.name+"'?")]);
      throwError(msg, that.spec.location, "Error-UnknownModule");
    }
 
    // if it's an invalid moduleName, throw an error
    if(!(resolvedModuleName || getWeSchemeModule(moduleName))){ throwModuleError(moduleName); }
 
    // processModule : JS -> pinfo
    // assumes the module has been assigned to window.COLLECTIONS.
    // pull out the bindings, and then add them to pinfo
    function processModule(moduleName){
      var provides = window.COLLECTIONS[moduleName].provides,
          strToBinding = function(p){
                            var b = new constantBinding(p, new symbolExpr(moduleName), false);
                            b.imported = true; // WTF: Moby treats imported bindings differently, so we need to identify them
                            return b;
                          },
          provideBindings = provides.map(strToBinding),
          modulebinding = new moduleBinding(moduleName, provideBindings);
      newPinfo = pinfo.accumulateModule(modulebinding).accumulateModuleBindings(provideBindings);
    }
 
    // open a *synchronous* GET request -- FIXME to use callbacks?
    var url = window.location.protocol+"//"+window.location.host
              + (getWeSchemeModule(moduleName)?  "/loadProject?publicId="+(getWeSchemeModule(moduleName))
                                              : "/js/mzscheme-vm/collects/"+moduleName+".js");
 
    // if the module is already loaded, we can just process without loading
    if(window.COLLECTIONS && window.COLLECTIONS[moduleName]){
      processModule(moduleName);
    } else {
      jQuery.ajax({
           url:    url,
           success: function(result) {
                      // if it's not a native module, manually assign it to window.COLLECTIONS
                      if(getWeSchemeModule(moduleName)){
                        var program = (0,eval)('(' + result + ')');
                        // Create the COLLECTIONS array, if it doesn't exist
                        if(!window.COLLECTIONS) window.COLLECTIONS = [];
                        window.COLLECTIONS[moduleName] = {
                                    'name': moduleName,
                                    'bytecode' : (0,eval)('(' + program.object.obj + ')'),
                                    'provides' : program.provides
                                };
                      // otherwise, simply evaluate the raw JS
                      } else {
                        eval(result);
                      }
                      if(result){ processModule(moduleName); }
                      else { throwModuleError(moduleName); }
                    },
           error: function (error) { throwModuleError(moduleName); },
           async:   false
      });
    }
    return newPinfo;
 };
/*
 localExpr.prototype.collectDefinitions = function(pinfo){
    // remember previously defined names, so we can revert to them later
    // in the meantime, scan the body
    var prevKeys = pinfo.definedNames.keys(),
        localPinfo= this.defs.reduce(function(pinfo, p){ return p.collectDefinitions(pinfo); }
                                        , pinfo),
        newPinfo  = this.body.collectDefinitions(localPinfo),
        newKeys = newPinfo.definedNames.keys();
    // now that the body is scanned, forget all the new definitions
    newKeys.forEach(function(k){ if(prevKeys.indexOf(k) === -1) newPinfo.definedNames.remove(k); });
    return newPinfo;
 };
 */
 // BINDING STRUCTS ///////////////////////////////////////////////////////
 function provideBindingId(symbl){ this.symbl = symbl;}
 function provideBindingStructId(symbl){ this.symbl = symbl; }

 //////////////////////////////////////////////////////////////////////////////
 // COLLECT PROVIDES //////////////////////////////////////////////////////////

 // extend the Program class to collect provides
 // Program.collectProvides: pinfo -> pinfo
 Program.prototype.collectProvides = function(pinfo){ return pinfo; };
 provideStatement.prototype.collectProvides = function(pinfo){
    var that = this;
 
    function addProvidedName(id){ pinfo.providedNames.put(id, new provideBindingId(id)); }
 
    // collectProvidesFromClause : pinfo clause -> pinfo
    function collectProvidesFromClause(pinfo, clause){
      // if it's a symbol, make sure it's defined (otherwise error)
      if (clause instanceof symbolExpr){
        if(pinfo.definedNames.containsKey(clause.val)){
          addProvidedName(clause.val);
          return pinfo;
        } else {
          var msg = new types.Message(["The name '"
                                       , new types.ColoredPart(clause.toString(), clause.location)
                                       , "', is not defined in the program, and cannot be provided."]);
          msg.betterThanServer = true;
          throwError(msg, clause.location);
        }
      // if it's an array, make sure the struct is defined (otherwise error)
      // NOTE: ONLY (struct-out id) IS SUPPORTED AT THIS TIME
      } else if(clause instanceof Array){
          if(pinfo.definedNames.containsKey(clause[1].val) &&
             (pinfo.definedNames.get(clause[1].val) instanceof structBinding)){
              // add the entire structBinding to the provided binding, so we
              // can access fieldnames, predicates, and permissions later
              var b = pinfo.definedNames.get(clause[1].val),
                  fns = [b.name, b.constructor, b.predicate].concat(b.accessors, b.mutators);
                  fns.forEach(addProvidedName);
              return pinfo;
          } else {
            throwError(new types.Message(["The struct '"
                                          , new types.ColoredPart(clause[1].toString(), clause[1].location)
                                          , "', is not defined in the program, and cannot be provided"])
                       , clause.location);
          }
      // anything with a different format throws an error
      } else {
        throw "Impossible: all invalid provide clauses should have been filtered out!";
      }
    }
    return this.clauses.reduce(collectProvidesFromClause, pinfo);
  };
 
 //////////////////////////////////////////////////////////////////////////////
 // ANALYZE USES //////////////////////////////////////////////////////////////

 // extend the Program class to analyzing uses
 // Program.analyzeUses: pinfo -> pinfo
 Program.prototype.analyzeUses = function(pinfo, env){ return pinfo; };
 defVar.prototype.analyzeUses = function(pinfo){
    // if it's a lambda, extend the environment with the function, then analyze as a lambda
    if(this.expr instanceof lambdaExpr) pinfo.env.extend(bf(this.name.val, false, this.expr.args.length, false, this.location));
    return this.expr.analyzeUses(pinfo, pinfo.env);
 };
 defVars.prototype.analyzeUses = function(pinfo){
    return this.expr.analyzeUses(pinfo, pinfo.env);
 };
 defFunc.prototype.analyzeUses = function(pinfo){
    // extend the env to include the function binding, then make a copy of all the bindings
    var oldEnv = pinfo.env.extend(bf(this.name.val, false, this.args.length, false, this.location)),
        oldKeys = oldEnv.bindings.keys(),
        newBindings = types.makeLowLevelEqHash();
    oldKeys.forEach(function(k){newBindings.put(k, oldEnv.bindings.get(k));});
 
    // make a copy of the environment, using the newly-copied bindings
    // add the args to this environment
    var newEnv = new plt.compiler.env(newBindings),
        newEnv = this.args.reduce(function(env, arg){
                                  return env.extend(new constantBinding(arg.val, false, [], arg.location));
                                }, newEnv);
    pinfo.env = newEnv;                           // install the post-arg env into pinfo
    pinfo = this.body.analyzeUses(pinfo, newEnv); // analyze the body
    pinfo.env = oldEnv;                           // install the pre-arg environment for pinfo
    return pinfo;
 };
 beginExpr.prototype.analyzeUses = function(pinfo, env){
    return this.exprs.reduce(function(p, expr){return expr.analyzeUses(p, env);}, pinfo);
 };
 // FIXME: Danny says that using a basePInfo is almost certainly a bug, but we're going to do it for now
 // to match the behavior in Moby, which promotes any closed variables to a global.
 lambdaExpr.prototype.analyzeUses = function(pinfo, env){
//    var env1 = pinfo.env, // FIXME: this is what the line *should* be
    var env1 = plt.compiler.getBasePinfo("base").env,
        env2 = this.args.reduce(function(env, arg){
          return env.extend(new constantBinding(arg.val, false, [], arg.location));
        }, env1);
    return this.body.analyzeUses(pinfo, env2);
 };

 /*
 // If we don't care about matching Danny's compiler, the code *probably should be*
 localExpr.prototype.analyzeUses = function(pinfo, env){
    var pinfoAfterDefs = this.defs.reduce(function(pinfo, d){ return d.analyzeUses(pinfo, env); }, pinfo);
    return this.body.analyzeUses(pinfoAfterDefs, env);
 };
 */
 
 // This is what we do to match Danny's compiler, which I think behaves incorrectly.
 // It's a horrible, horrible hack designed to get around the fact that our structures don't
 // behave functionally. SHOULD BE TESTED FURTHER
 localExpr.prototype.analyzeUses = function(pinfo, env){
    pinfo.env = plt.compiler.getBasePinfo("base").env;
    var pinfoAfterDefs = this.defs.reduce(function(pinfo, d){ return d.analyzeUses(pinfo);}, pinfo);
 
     // extend the env to include the function binding, then make a copy of all the bindings
    var envAfterDefs = pinfoAfterDefs.env, oldKeys = envAfterDefs.bindings.keys(),
        newBindings = types.makeLowLevelEqHash();
    oldKeys.forEach(function(k){newBindings.put(k, envAfterDefs.bindings.get(k));});

    var bodyPinfo = this.body.analyzeUses(pinfoAfterDefs, envAfterDefs);
    bodyPinfo.env = envAfterDefs;
    return bodyPinfo;
 };
 
 callExpr.prototype.analyzeUses = function(pinfo, env){
    return [this.func].concat(this.args).reduce(function(p, arg){
                            return (arg instanceof Array)?
                                    // if arg is a subexpression, reduce THAT
                                    arg.reduce((function(pinfo, p){return p.analyzeUses(pinfo, pinfo.env);})
                                               , pinfo)
                                    // otherwise analyze and return
                                    : arg.analyzeUses(p, env);
                            }, pinfo);
 }
 ifExpr.prototype.analyzeUses = function(pinfo, env){
    var exps = [this.predicate, this.consequence, this.alternative];
    return exps.reduce(function(p, exp){
                            return exp.analyzeUses(p,env);
                            }, pinfo);
 };
 symbolExpr.prototype.analyzeUses = function(pinfo, env){
    // if this is a keyword without a parent, or if it's not the first child of the parent
    if((plt.compiler.keywords.indexOf(this.val) > -1) &&
       (!this.parent || this.parent[0]!== this) || (this.parent instanceof couple)){
        throwError(new types.Message([new types.ColoredPart(this.val, this.location)
                                      , ": expected an open parenthesis before "
                                      , this.val
                                      , ", but found none"]),
                    this.location);
    }
    var binding = env.lookup_context(this.val);
    if(binding){
      return pinfo.accumulateBindingUse(binding, pinfo);
    } else {
      return pinfo.accumulateFreeVariableUse(this.val, pinfo);
    }
 };


/////////////////////////////////////////////////////////////
 function analyze(programs){
    return programAnalyzeWithPinfo(programs, plt.compiler.getBasePinfo("base"));
 }
 
 // programAnalyzerWithPinfo : [listof Programs], pinfo -> pinfo
 // build up pinfo by looking at definitions, provides and uses
 function programAnalyzeWithPinfo(programs, pinfo){
   // collectDefinitions: [listof Programs] pinfo -> pinfo
   // Collects the definitions either imported or defined by this program.
   function collectDefinitions(programs, pinfo){
     return programs.reduce((function(pinfo, p){ return p.collectDefinitions(pinfo); })
                            , pinfo);
   }
   // collectProvides: [listof Programs] pinfo -> pinfo
   // Walk through the program and collect all the provide statements.
   function collectProvides(programs, pinfo){
      return programs.reduce((function(pinfo, p){ return p.collectProvides(pinfo); })
                             , pinfo);
   }
   // analyzeUses: [listof Programs] pinfo -> pinfo
   // Collects the uses of bindings that this program uses.
    function analyzeUses(programs, pinfo){
      return programs.reduce((function(pinfo, p){ return p.analyzeUses(pinfo, pinfo.env); })
                             , pinfo);
    }
    var pinfo1 = collectDefinitions(programs, pinfo);
    var pinfo2 = collectProvides(programs, pinfo1);
    return analyzeUses(programs, pinfo2);
 }
 
 /////////////////////
 /* Export Bindings */
 /////////////////////
 plt.compiler.desugar = function(p, pinfo, debug){
    var start       = new Date().getTime();
    try {
      var ASTandPinfo = desugarProgram(p, pinfo, true), // do the actual work
          program     = ASTandPinfo[0],
          pinfo       = ASTandPinfo[1];
    } catch (e) { console.log("DESUGARING ERROR"); throw e; }
    var end = new Date().getTime();
    if(debug){
      console.log("Desugared in "+(Math.floor(end-start))+"ms");
      console.log(program);
      console.log(program.toString());
    }
    return ASTandPinfo;
  };
 plt.compiler.analyze = function(program, debug){
    var start       = new Date().getTime();
    try { var pinfo       = analyze(program); }             // do the actual work
    catch (e) { console.log("ANALYSIS ERROR"); throw e; }
    var end         = new Date().getTime();
    if(debug){
      console.log("Analyzed in "+(Math.floor(end-start))+"ms");
//      console.log(pinfo.toString());
    }
    return pinfo;
  };
 plt.compiler.provideBindingId = provideBindingId;
 plt.compiler.provideBindingStructId = provideBindingStructId;
})();
